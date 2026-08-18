import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Prisma, SupportTicket, TicketMessage } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionCode } from '../identity/constants/permission-code';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  AddTicketMessageDto,
  AdminCreateTicketDto,
  AdminTicketQueryDto,
  AssignTicketDto,
  CreateTicketDto,
  EscalateTicketDto,
  ResolveTicketDto,
} from './dto/ticket.dto';
import {
  SUPPORT_EVENTS,
  SUPPORT_TEMPLATES,
  TICKET_OPEN_STATUSES,
  type TicketCategory,
  type TicketPriority,
  type TicketRaiserType,
} from './support.types';

/** Who a raiser-facing call is speaking for. */
type RaiserType = 'customer' | 'pro';

/**
 * Support tickets — features 6 to 10.
 *
 * ## The two invisibility rules, and where they live
 *
 * These are the rules most likely to be got wrong later, so neither is
 * implemented by filtering rows after they are loaded:
 *
 * | Rule | Enforcement |
 * | -- | -- |
 * | An **internal ticket** is invisible to the customer and the Pro | {@link raiserScope} adds `isInternal: false` **and** the actor's own id to every non-admin query. No customer/Pro path touches `prisma.supportTicket` directly |
 * | An **internal note** is invisible to the raiser | {@link RAISER_MESSAGE_INCLUDE} carries `where: { isInternalNote: false }`, so the rows are never loaded |
 *
 * The difference matters. A filter over loaded rows keeps working until
 * somebody adds an `include` or a spread, and then quietly stops. A `where`
 * clause cannot leak what it never fetched.
 *
 * A ticket the caller may not see returns **404, not 403**. `403` confirms it
 * exists, which for a quietly-handled no-start incident is exactly the fact
 * feature 13 says the Pro must not have.
 */
@Injectable()
export class SupportTicketsService {
  private readonly logger = new Logger(SupportTicketsService.name);

  /** Messages as a raiser may see them: internal notes are never loaded. */
  private static readonly RAISER_MESSAGE_INCLUDE = {
    messages: {
      where: { isInternalNote: false },
      orderBy: { sentAt: 'asc' },
    },
  } as const satisfies Prisma.SupportTicketInclude;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------
  // Raising
  // -------------------------------------------------------------------

  async createForRaiser(
    actorId: string,
    raiserType: RaiserType,
    dto: CreateTicketDto,
  ): Promise<SupportTicket> {
    if (dto.category === 'dispute' && !dto.bookingId)
      throw apiError(
        'A dispute needs the booking it is about — the evidence bundle has ' +
          'nothing to assemble without one.',
      );

    if (dto.bookingId)
      await this.assertBookingOwnership(dto.bookingId, actorId, raiserType);

    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          raisedByType: raiserType satisfies TicketRaiserType,
          customerId: raiserType === 'customer' ? actorId : null,
          proId: raiserType === 'pro' ? actorId : null,
          bookingId: dto.bookingId ?? null,
          category: dto.category,
          subject: dto.subject,
          isInternal: false,
        },
      });

      await tx.ticketMessage.create({
        data: {
          ticketId: created.id,
          senderType: raiserType,
          senderId: actorId,
          body: dto.body,
          attachmentUrl: dto.attachmentKey ?? null,
        },
      });

      return created;
    });

    await this.notifyQueue(ticket);
    return ticket;
  }

  async createForAdmin(dto: AdminCreateTicketDto): Promise<SupportTicket> {
    if (!dto.customerId && !dto.proId && !dto.bookingId)
      throw apiError(
        'A ticket needs somebody or something to be about — supply a ' +
          'customer, a Pro, or a booking.',
      );

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          // Ops raising on behalf of a party still records the party as the
          // raiser; `system` is reserved for tickets no human filed.
          raisedByType: dto.proId && !dto.customerId ? 'pro' : 'customer',
          customerId: dto.customerId ?? null,
          proId: dto.proId ?? null,
          bookingId: dto.bookingId ?? null,
          category: dto.category satisfies TicketCategory,
          subject: dto.subject,
          priority: (dto.priority ?? 'normal') satisfies TicketPriority,
          isInternal: dto.isInternal ?? false,
        },
      });

      await tx.ticketMessage.create({
        data: {
          ticketId: created.id,
          senderType: 'admin',
          senderId: 'admin',
          body: dto.body,
          isInternalNote: created.isInternal,
        },
      });

      return created;
    });
  }

  /**
   * The system's own entry point — module 7's unpaid cash job, and anything
   * else that needs a quiet ops case.
   *
   * `systemKey` makes "cannot raise twice" a database guarantee rather than a
   * race between two callers, which matters because every system raiser here
   * is a sweep that will run again in a few minutes.
   */
  async raiseSystemTicket(input: {
    systemKey: string;
    category: TicketCategory;
    subject: string;
    body: string;
    priority?: TicketPriority;
    bookingId?: string | null;
    customerId?: string | null;
    proId?: string | null;
    contextJson?: Prisma.InputJsonValue;
  }): Promise<SupportTicket | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.supportTicket.create({
          data: {
            raisedByType: 'system',
            // Enforced by a CHECK constraint too — the system never raises a
            // ticket the person it is about can read (feature 13).
            isInternal: true,
            systemKey: input.systemKey,
            category: input.category,
            subject: input.subject,
            priority: input.priority ?? 'normal',
            bookingId: input.bookingId ?? null,
            customerId: input.customerId ?? null,
            proId: input.proId ?? null,
            contextJson: input.contextJson,
          },
        });

        await tx.ticketMessage.create({
          data: {
            ticketId: created.id,
            senderType: 'system',
            senderId: 'system',
            body: input.body,
            isInternalNote: true,
          },
        });

        return created;
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        // Already raised. The expected outcome on every sweep after the first.
        return null;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------
  // Raiser-facing reads
  // -------------------------------------------------------------------

  listForRaiser(actorId: string, raiserType: RaiserType) {
    return this.prisma.supportTicket.findMany({
      where: this.raiserScope(actorId, raiserType),
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async getForRaiser(id: string, actorId: string, raiserType: RaiserType) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, ...this.raiserScope(actorId, raiserType) },
      include: SupportTicketsService.RAISER_MESSAGE_INCLUDE,
    });
    if (!ticket) throw apiError('Ticket not found', HttpStatus.NOT_FOUND);
    return ticket;
  }

  // -------------------------------------------------------------------
  // Threading
  // -------------------------------------------------------------------

  /**
   * A reply from the raiser.
   *
   * **A reply to a resolved ticket reopens it.** Resolution is ops's opinion
   * that the problem is over; only the raiser's silence confirms it. Writes
   * close at `closed` and reads never do — the same asymmetry booking chat
   * already uses (CONFLICTS_AND_DECISIONS #23).
   */
  async addRaiserMessage(
    id: string,
    actorId: string,
    raiserType: RaiserType,
    dto: AddTicketMessageDto,
  ): Promise<TicketMessage> {
    if (dto.isInternalNote)
      throw apiError(
        'Only an admin can write an internal note. Sending this as a normal ' +
          'message would have made it visible to everyone on the ticket.',
      );

    const ticket = await this.getForRaiser(id, actorId, raiserType);
    if (ticket.status === 'closed')
      throw apiError(
        'This ticket is closed. Raise a new one and reference it.',
        HttpStatus.CONFLICT,
      );

    const [message] = await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: id,
          senderType: raiserType,
          senderId: actorId,
          body: dto.body,
          attachmentUrl: dto.attachmentKey ?? null,
          isInternalNote: false,
        },
      }),
      this.prisma.supportTicket.update({
        where: { id },
        data:
          ticket.status === 'resolved'
            ? { status: 'in_progress', resolvedAt: null }
            : {},
      }),
    ]);

    return message;
  }

  /** An admin reply, or an internal note nobody outside ops will ever see. */
  async addAdminMessage(
    id: string,
    adminId: string,
    dto: AddTicketMessageDto,
  ): Promise<TicketMessage> {
    const ticket = await this.getForAdmin(id);

    const message = await this.prisma.ticketMessage.create({
      data: {
        ticketId: id,
        senderType: 'admin',
        senderId: adminId,
        body: dto.body,
        attachmentUrl: dto.attachmentKey ?? null,
        isInternalNote: dto.isInternalNote ?? false,
      },
    });

    // An internal note is not a reply. Telling the raiser one arrived would
    // announce the existence of a conversation they cannot read.
    if (!message.isInternalNote && !ticket.isInternal)
      await this.notifyRaiser(
        ticket,
        SUPPORT_EVENTS.ticketReplied,
        SUPPORT_TEMPLATES.ticketRepliedRaiser,
        `${SUPPORT_EVENTS.ticketReplied}:${message.id}`,
      );

    return message;
  }

  // -------------------------------------------------------------------
  // Ops workflow
  // -------------------------------------------------------------------

  listForAdmin(query: AdminTicketQueryDto) {
    return this.prisma.supportTicket.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assignedAdminId
          ? { assignedAdminId: query.assignedAdminId }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });
  }

  async getForAdmin(id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { sentAt: 'asc' } } },
    });
    if (!ticket) throw apiError('Ticket not found', HttpStatus.NOT_FOUND);
    return ticket;
  }

  /**
   * Assignment refuses an admin who cannot act on the ticket.
   *
   * Assigning to somebody without `support.ticket.manage` produces a ticket
   * that looks owned and is parked forever — the worst state in a queue,
   * because it stops being triaged without ever being worked.
   */
  async assign(id: string, dto: AssignTicketDto): Promise<SupportTicket> {
    const ticket = await this.getForAdmin(id);

    const assignee = await this.prisma.adminUser.findUnique({
      where: { id: dto.adminUserId },
      select: {
        isActive: true,
        role: { select: { permissionCodes: true } },
      },
    });
    if (!assignee) throw apiError('Admin not found', HttpStatus.NOT_FOUND);

    const codes = assignee.role.permissionCodes;
    const canManage =
      Array.isArray(codes) &&
      codes.includes(PermissionCode.SUPPORT_TICKET_MANAGE);

    if (!assignee.isActive || !canManage)
      throw apiError(
        'That admin cannot work support tickets. Assigning anyway would park ' +
          'the ticket rather than move it.',
        HttpStatus.CONFLICT,
      );

    return this.prisma.supportTicket.update({
      where: { id },
      data: {
        assignedAdminId: dto.adminUserId,
        status: ticket.status === 'open' ? 'in_progress' : ticket.status,
      },
    });
  }

  /**
   * Escalation always leaves a trace in the thread.
   *
   * A status change with no explanation is a status change, not an
   * escalation — the next person to open the ticket needs to know what
   * prompted it.
   */
  async escalate(
    id: string,
    adminId: string,
    dto: EscalateTicketDto,
  ): Promise<SupportTicket> {
    const ticket = await this.getForAdmin(id);
    if (ticket.status === 'closed')
      throw apiError('This ticket is closed', HttpStatus.CONFLICT);

    return this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          senderType: 'system',
          senderId: adminId,
          body: `Escalated: ${dto.reason}`,
          isInternalNote: true,
        },
      });

      return tx.supportTicket.update({
        where: { id },
        data: {
          status: 'escalated',
          escalatedAt: ticket.escalatedAt ?? new Date(),
          ...(dto.priority ? { priority: dto.priority } : {}),
          ...(dto.assignToAdminUserId
            ? { assignedAdminId: dto.assignToAdminUserId }
            : {}),
        },
      });
    });
  }

  /**
   * Close-out. Notes and an action are both required here **and** by a CHECK
   * constraint — mirroring module 10's moderation rule, where closing without
   * saying why is refused by the database rather than only by the service.
   */
  async resolve(
    id: string,
    adminId: string,
    dto: ResolveTicketDto,
  ): Promise<SupportTicket> {
    const ticket = await this.getForAdmin(id);
    if (!TICKET_OPEN_STATUSES.includes(ticket.status as never))
      throw apiError('This ticket is already closed', HttpStatus.CONFLICT);

    const resolved = await this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          senderType: 'system',
          senderId: adminId,
          body: `Resolved (${dto.actionTaken}): ${dto.resolutionNotes}`,
          isInternalNote: true,
        },
      });

      return tx.supportTicket.update({
        where: { id },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes: dto.resolutionNotes,
          actionTaken: dto.actionTaken,
        },
      });
    });

    if (!resolved.isInternal)
      await this.notifyRaiser(
        resolved,
        SUPPORT_EVENTS.ticketResolved,
        SUPPORT_TEMPLATES.ticketResolvedRaiser,
        `${SUPPORT_EVENTS.ticketResolved}:${resolved.id}`,
      );

    return resolved;
  }

  /**
   * Closes a system ticket that fixed itself.
   *
   * Used by the no-start sweep. Without it, every OTP delay longer than the
   * grace window leaves ops a ticket about a job that was already running by
   * the time they opened it — and a queue of self-resolved tickets is how ops
   * learns to stop reading the queue.
   */
  async autoResolveSystemTicket(id: string, notes: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          senderType: 'system',
          senderId: 'system',
          body: notes,
          isInternalNote: true,
        },
      });
      await tx.supportTicket.update({
        where: { id },
        data: {
          status: 'resolved',
          resolvedAt: new Date(),
          resolutionNotes: notes,
          actionTaken: 'none',
        },
      });
    });
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * The one place the raiser-visibility rule is expressed.
   *
   * Both halves matter: `isInternal: false` hides ops's private cases, and the
   * actor id hides everybody else's tickets. Every customer and Pro route
   * composes this — none queries `supportTicket` on its own.
   */
  private raiserScope(
    actorId: string,
    raiserType: RaiserType,
  ): Prisma.SupportTicketWhereInput {
    return {
      isInternal: false,
      ...(raiserType === 'customer'
        ? { customerId: actorId }
        : { proId: actorId }),
    };
  }

  private async assertBookingOwnership(
    bookingId: string,
    actorId: string,
    raiserType: RaiserType,
  ): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerId: true, proId: true },
    });

    const owns =
      booking &&
      (raiserType === 'customer'
        ? booking.customerId === actorId
        : booking.proId === actorId);

    if (!owns) throw apiError('Booking not found', HttpStatus.NOT_FOUND);
  }

  /** Tells the on-duty queue a new ticket arrived. Never fatal. */
  private async notifyQueue(ticket: SupportTicket): Promise<void> {
    const admins = await this.prisma.adminUser.findMany({
      where: { isActive: true },
      select: { id: true, role: { select: { permissionCodes: true } } },
    });

    const recipients = admins.filter((admin) => {
      const codes = admin.role.permissionCodes;
      return (
        Array.isArray(codes) &&
        codes.includes(PermissionCode.SUPPORT_TICKET_MANAGE)
      );
    });

    for (const recipient of recipients) {
      try {
        await this.notifications.enqueue({
          eventKey: SUPPORT_EVENTS.ticketRaised,
          dedupeKey: `${SUPPORT_EVENTS.ticketRaised}:${ticket.id}:${recipient.id}`,
          templateKey: SUPPORT_TEMPLATES.ticketRaisedAdmin,
          recipientType: 'admin',
          recipientId: recipient.id,
          bookingId: ticket.bookingId ?? undefined,
          variables: {
            ticketId: ticket.id,
            category: ticket.category,
            subject: ticket.subject,
          },
        });
      } catch (error) {
        this.logger.error(
          `Could not notify admin ${recipient.id} of ticket ${ticket.id}: ` +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }
    }
  }

  private async notifyRaiser(
    ticket: SupportTicket,
    eventKey: string,
    templateKey: string,
    dedupeKey: string,
  ): Promise<void> {
    const recipientType = ticket.customerId ? 'customer' : 'pro';
    const recipientId = ticket.customerId ?? ticket.proId;
    if (!recipientId) return;

    try {
      await this.notifications.enqueue({
        eventKey,
        dedupeKey,
        templateKey,
        recipientType,
        recipientId,
        bookingId: ticket.bookingId ?? undefined,
        variables: { ticketId: ticket.id, subject: ticket.subject },
      });
    } catch (error) {
      this.logger.error(
        `Could not notify the raiser of ticket ${ticket.id}: ` +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }
  }
}
