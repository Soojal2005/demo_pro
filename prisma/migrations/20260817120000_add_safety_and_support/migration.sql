-- Module 11 · Safety & Support — SosAlert, SupportTicket, TicketMessage.
--
-- The CHECK constraints below are the point of this file, not decoration.
-- Two of them carry rules the service layer also enforces, and they are
-- repeated here for the reason the rest of this schema repeats them: a future
-- code path that has not been written yet must not be able to produce a row
-- that says someone responded to a safety alert when nobody did.

CREATE TABLE "sos_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "raisedByType" TEXT NOT NULL,
  "customerId" UUID,
  "proId" UUID,
  "bookingId" UUID,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contextSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "acknowledgedByAdminId" UUID,
  "acknowledgedAt" TIMESTAMP(3),
  "resolvedByAdminId" UUID,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNotes" TEXT,
  CONSTRAINT "sos_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sos_alerts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "sos_alerts_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE,
  CONSTRAINT "sos_alerts_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL,
  CONSTRAINT "sos_alerts_acknowledgedByAdminId_fkey" FOREIGN KEY ("acknowledgedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "sos_alerts_resolvedByAdminId_fkey" FOREIGN KEY ("resolvedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "sos_alerts_raised_by_type_check" CHECK ("raisedByType" IN ('customer', 'pro')),
  CONSTRAINT "sos_alerts_status_check" CHECK ("status" IN ('open', 'acknowledged', 'resolved', 'false_alarm')),
  -- Whoever pressed the button must be identifiable. An alert attributed to
  -- nobody cannot be called back.
  CONSTRAINT "sos_alerts_raiser_present_check" CHECK (
    ("raisedByType" = 'customer' AND "customerId" IS NOT NULL)
    OR ("raisedByType" = 'pro' AND "proId" IS NOT NULL)
  ),
  -- A status past 'open' claims someone saw it. That claim carries a name and
  -- a timestamp or it is not made.
  CONSTRAINT "sos_alerts_acknowledged_complete_check" CHECK (
    "status" = 'open'
    OR ("acknowledgedAt" IS NOT NULL AND "acknowledgedByAdminId" IS NOT NULL)
  ),
  CONSTRAINT "sos_alerts_resolved_complete_check" CHECK (
    "status" NOT IN ('resolved', 'false_alarm')
    OR ("resolvedAt" IS NOT NULL AND "resolvedByAdminId" IS NOT NULL)
  )
);
CREATE INDEX "sos_alerts_status_raisedAt_idx" ON "sos_alerts"("status", "raisedAt");
CREATE INDEX "sos_alerts_bookingId_idx" ON "sos_alerts"("bookingId");
CREATE INDEX "sos_alerts_customerId_raisedAt_idx" ON "sos_alerts"("customerId", "raisedAt");
CREATE INDEX "sos_alerts_proId_raisedAt_idx" ON "sos_alerts"("proId", "raisedAt");

CREATE TABLE "support_tickets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "raisedByType" TEXT NOT NULL,
  "customerId" UUID,
  "proId" UUID,
  "bookingId" UUID,
  "category" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'open',
  "isInternal" BOOLEAN NOT NULL DEFAULT false,
  "contextJson" JSONB,
  "systemKey" TEXT,
  "assignedAdminId" UUID,
  "resolutionNotes" TEXT,
  "actionTaken" TEXT,
  "escalatedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "support_tickets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "support_tickets_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE,
  CONSTRAINT "support_tickets_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL,
  CONSTRAINT "support_tickets_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "support_tickets_raised_by_type_check" CHECK ("raisedByType" IN ('customer', 'pro', 'system')),
  CONSTRAINT "support_tickets_category_check" CHECK ("category" IN ('billing', 'quality', 'dispute', 'app_issue', 'no_start')),
  CONSTRAINT "support_tickets_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('open', 'in_progress', 'escalated', 'resolved', 'closed')),
  CONSTRAINT "support_tickets_action_taken_check" CHECK (
    "actionTaken" IS NULL
    OR "actionTaken" IN ('none', 'warning', 'retraining', 'service_suspended', 'suspended')
  ),
  -- Feature 13, at the database. The system never raises a ticket the person
  -- it is about can read.
  CONSTRAINT "support_tickets_system_is_internal_check" CHECK (
    "raisedByType" <> 'system' OR "isInternal" = true
  ),
  CONSTRAINT "support_tickets_raiser_present_check" CHECK (
    ("raisedByType" = 'customer' AND "customerId" IS NOT NULL)
    OR ("raisedByType" = 'pro' AND "proId" IS NOT NULL)
    OR "raisedByType" = 'system'
  ),
  -- A no-start incident is about a specific job, always.
  CONSTRAINT "support_tickets_no_start_has_booking_check" CHECK (
    "category" <> 'no_start' OR "bookingId" IS NOT NULL
  ),
  -- Closing without saying why is refused here, not only in the service —
  -- mirroring module 10's moderation rule.
  CONSTRAINT "support_tickets_resolution_complete_check" CHECK (
    "status" NOT IN ('resolved', 'closed')
    OR ("resolvedAt" IS NOT NULL AND "resolutionNotes" IS NOT NULL AND "actionTaken" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "support_tickets_systemKey_key" ON "support_tickets"("systemKey");
CREATE INDEX "support_tickets_status_priority_createdAt_idx" ON "support_tickets"("status", "priority", "createdAt");
CREATE INDEX "support_tickets_assignedAdminId_status_idx" ON "support_tickets"("assignedAdminId", "status");
CREATE INDEX "support_tickets_bookingId_idx" ON "support_tickets"("bookingId");
CREATE INDEX "support_tickets_customerId_createdAt_idx" ON "support_tickets"("customerId", "createdAt");
CREATE INDEX "support_tickets_proId_createdAt_idx" ON "support_tickets"("proId", "createdAt");
CREATE INDEX "support_tickets_category_status_idx" ON "support_tickets"("category", "status");

CREATE TABLE "ticket_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ticketId" UUID NOT NULL,
  "senderType" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "attachmentUrl" TEXT,
  "isInternalNote" BOOLEAN NOT NULL DEFAULT false,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE,
  CONSTRAINT "ticket_messages_sender_type_check" CHECK ("senderType" IN ('customer', 'pro', 'admin', 'system')),
  -- A customer cannot author a note hidden from themselves, and nothing
  -- should ever be able to construct one.
  CONSTRAINT "ticket_messages_internal_note_author_check" CHECK (
    "isInternalNote" = false OR "senderType" IN ('admin', 'system')
  )
);
CREATE INDEX "ticket_messages_ticketId_sentAt_idx" ON "ticket_messages"("ticketId", "sentAt");
