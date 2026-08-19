CREATE TABLE "notification_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isCritical" BOOLEAN NOT NULL DEFAULT false,
  "channels" JSONB NOT NULL,
  "pushTitle" TEXT,
  "pushBody" TEXT,
  "whatsappTemplate" TEXT,
  "smsBody" TEXT,
  "allowedVariables" JSONB NOT NULL DEFAULT '[]',
  "retryLimit" INTEGER NOT NULL DEFAULT 2,
  "fallbackDelaySeconds" INTEGER NOT NULL DEFAULT 0,
  "updatedByAdminId" UUID,
  CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_templates_updatedByAdminId_fkey" FOREIGN KEY ("updatedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "notification_templates_retryLimit_check" CHECK ("retryLimit" BETWEEN 0 AND 10),
  CONSTRAINT "notification_templates_fallbackDelaySeconds_check" CHECK ("fallbackDelaySeconds" BETWEEN 0 AND 3600)
);
CREATE UNIQUE INDEX "notification_templates_key_key" ON "notification_templates"("key");
CREATE INDEX "notification_templates_eventType_isActive_idx" ON "notification_templates"("eventType", "isActive");

CREATE TABLE "notification_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "eventKey" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "recipientType" TEXT NOT NULL,
  "customerId" UUID,
  "proId" UUID,
  "adminUserId" UUID,
  "bookingId" UUID,
  "templateKey" TEXT NOT NULL,
  "variablesJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "processedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_outbox_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_outbox_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_outbox_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_outbox_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_outbox_one_recipient_check" CHECK (num_nonnulls("customerId", "proId", "adminUserId") = 1),
  CONSTRAINT "notification_outbox_recipient_type_check" CHECK ("recipientType" IN ('customer', 'pro', 'admin')),
  CONSTRAINT "notification_outbox_status_check" CHECK ("status" IN ('queued', 'processing', 'completed', 'failed'))
);
CREATE UNIQUE INDEX "notification_outbox_dedupeKey_key" ON "notification_outbox"("dedupeKey");
CREATE INDEX "notification_outbox_status_availableAt_idx" ON "notification_outbox"("status", "availableAt");
CREATE INDEX "notification_outbox_bookingId_createdAt_idx" ON "notification_outbox"("bookingId", "createdAt");

CREATE TABLE "notification_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "outboxId" UUID,
  "dedupeKey" TEXT NOT NULL,
  "recipientType" TEXT NOT NULL,
  "customerId" UUID,
  "proId" UUID,
  "adminUserId" UUID,
  "recipientMasked" TEXT,
  "bookingId" UUID,
  "channel" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "templateKey" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  "providerReference" TEXT,
  "failureCode" TEXT,
  "failureReason" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_logs_outboxId_fkey" FOREIGN KEY ("outboxId") REFERENCES "notification_outbox"("id") ON DELETE SET NULL,
  CONSTRAINT "notification_logs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_logs_proId_fkey" FOREIGN KEY ("proId") REFERENCES "pros"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_logs_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_logs_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_logs_at_most_one_recipient_check" CHECK (num_nonnulls("customerId", "proId", "adminUserId") <= 1),
  CONSTRAINT "notification_logs_recipient_type_check" CHECK ("recipientType" IN ('customer', 'pro', 'admin')),
  CONSTRAINT "notification_logs_channel_check" CHECK ("channel" IN ('push', 'whatsapp', 'sms')),
  CONSTRAINT "notification_logs_status_check" CHECK ("status" IN ('queued', 'sending', 'accepted', 'delivered', 'failed', 'skipped', 'read'))
);
CREATE UNIQUE INDEX "notification_logs_dedupeKey_channel_attemptNumber_key" ON "notification_logs"("dedupeKey", "channel", "attemptNumber");
CREATE INDEX "notification_logs_bookingId_createdAt_idx" ON "notification_logs"("bookingId", "createdAt");
CREATE INDEX "notification_logs_status_createdAt_idx" ON "notification_logs"("status", "createdAt");
CREATE INDEX "notification_logs_provider_providerReference_idx" ON "notification_logs"("provider", "providerReference");
CREATE INDEX "notification_logs_customerId_createdAt_idx" ON "notification_logs"("customerId", "createdAt");
CREATE INDEX "notification_logs_proId_createdAt_idx" ON "notification_logs"("proId", "createdAt");
CREATE INDEX "notification_logs_adminUserId_createdAt_idx" ON "notification_logs"("adminUserId", "createdAt");

INSERT INTO "notification_templates" (
  "id", "createdAt", "updatedAt", "key", "description", "eventType",
  "isCritical", "channels", "pushTitle", "pushBody", "whatsappTemplate",
  "smsBody", "allowedVariables", "retryLimit", "fallbackDelaySeconds"
)
SELECT gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, v.key, v.description,
  v.event_type, v.critical, v.channels::jsonb, v.push_title, v.push_body,
  v.whatsapp_template, v.sms_body, v.variables::jsonb, v.retry_limit, 0
FROM (VALUES
  ('dispatch.assignment_offered', 'Immediate job assignment alert for a Pro.', 'dispatch.assigned', true, '["push","sms"]', 'New job assigned', 'Booking {{bookingNumber}} needs acknowledgement by {{ackDeadline}}.', NULL, 'Homingo: Job {{bookingNumber}} assigned. Acknowledge by {{ackDeadline}}.', '["bookingNumber","ackDeadline"]', 1),
  ('booking.pro_assigned', 'First Pro assignment shown to the customer.', 'booking.assigned', false, '["push"]', 'Your Pro is assigned', '{{proName}} is assigned to booking {{bookingNumber}}.', NULL, NULL, '["bookingNumber","proName"]', 2),
  ('booking.pro_reassigned', 'Correction when the assigned Pro changes.', 'booking.reassigned', true, '["push","whatsapp","sms"]', 'Your assigned Pro changed', '{{proName}} is now assigned to booking {{bookingNumber}}.', 'booking_pro_reassigned', 'Homingo correction: {{proName}} is now assigned to booking {{bookingNumber}}.', '["bookingNumber","proName"]', 1),
  ('booking.assignment_confirmed', 'Pro acknowledgement confirmation.', 'booking.acknowledged', false, '["push"]', 'Assignment confirmed', '{{proName}} confirmed booking {{bookingNumber}}.', NULL, NULL, '["bookingNumber","proName"]', 2),
  ('booking.pro_en_route', 'Pro started travelling.', 'booking.en_route', false, '["push"]', 'Your Pro is on the way', '{{proName}} is travelling to booking {{bookingNumber}}.', NULL, NULL, '["bookingNumber","proName"]', 2),
  ('booking.pro_arrived', 'Doorstep arrival alert.', 'booking.arrived', true, '["push","whatsapp","sms"]', 'Your Pro has arrived', '{{proName}} has arrived for booking {{bookingNumber}}.', 'booking_pro_arrived', 'Homingo: {{proName}} has arrived for booking {{bookingNumber}}.', '["bookingNumber","proName"]', 1),
  ('booking.started', 'Work-start confirmation.', 'booking.started', false, '["push"]', 'Service started', 'Work has started for booking {{bookingNumber}}.', NULL, NULL, '["bookingNumber"]', 2),
  ('booking.completed', 'Work completion confirmation.', 'booking.completed', false, '["push"]', 'Service completed', 'Booking {{bookingNumber}} is complete.', NULL, NULL, '["bookingNumber"]', 2),
  ('booking.cancelled', 'Booking cancellation alert.', 'booking.cancelled', true, '["push","whatsapp","sms"]', 'Booking cancelled', 'Booking {{bookingNumber}} was cancelled.', 'booking_cancelled', 'Homingo: Booking {{bookingNumber}} was cancelled.', '["bookingNumber"]', 1),
  ('commission.payout_processed', 'Successful payout alert.', 'commission.paid', false, '["push"]', 'Payout completed', 'Your payout of INR {{amount}} has been processed.', NULL, NULL, '["amount"]', 2),
  ('commission.payout_failed', 'Failed payout alert.', 'commission.failed', true, '["push","sms"]', 'Payout needs attention', 'Your payout could not be completed. Homingo support is reviewing it.', NULL, 'Homingo: Your payout could not be completed. Support is reviewing it.', '[]', 1),
  ('safety.sos_created', 'Immediate SOS alert for scoped admins.', 'safety.sos_created', true, '["push","sms"]', 'Emergency alert', 'SOS raised for booking {{bookingNumber}}.', NULL, 'URGENT Homingo SOS for booking {{bookingNumber}}.', '["bookingNumber"]', 0)
) AS v(key, description, event_type, critical, channels, push_title, push_body, whatsapp_template, sms_body, variables, retry_limit)
WHERE NOT EXISTS (SELECT 1 FROM "notification_templates" t WHERE t."key" = v.key);

UPDATE "roles"
SET "permissionCodes" = COALESCE("permissionCodes", '[]'::jsonb) || '["notification.read","notification.template.manage","notification.retry"]'::jsonb
WHERE "name" IN ('ops', 'support', 'super_admin');
