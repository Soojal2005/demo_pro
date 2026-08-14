CREATE TABLE "admin_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "adminUserId" UUID NOT NULL,
  "jobType" TEXT NOT NULL,
  "targetEntity" TEXT NOT NULL,
  "filterJson" JSONB NOT NULL,
  "changesJson" JSONB,
  "format" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "succeededCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "resultFileKey" TEXT,
  "failureReason" TEXT,
  "requesterIp" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "admin_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_jobs_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "admin_jobs_type_check" CHECK ("jobType" IN ('bulk_update', 'report_export')),
  CONSTRAINT "admin_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'partial', 'failed')),
  CONSTRAINT "admin_jobs_format_check" CHECK ("format" IS NULL OR "format" IN ('csv', 'xlsx', 'pdf'))
);

CREATE INDEX "admin_jobs_adminUserId_createdAt_idx" ON "admin_jobs"("adminUserId", "createdAt");
CREATE INDEX "admin_jobs_status_createdAt_idx" ON "admin_jobs"("status", "createdAt");

-- Production deploys run migrations, not the Firebase-backed development
-- seed. Add the new console grants to existing system roles without deleting
-- any custom permissions an operator may already have added.
WITH grants(role_name, permissions) AS (
  VALUES
    ('ops', ARRAY[
      'admin.dashboard.read', 'customer.read', 'pro.read', 'dispatch.read',
      'admin.job.read', 'admin.bulk.execute', 'report.export',
      'report.analytics.read', 'platformSetting.read'
    ]::TEXT[]),
    ('support', ARRAY[
      'admin.dashboard.read', 'customer.read', 'pro.read', 'dispatch.read',
      'admin.job.read', 'report.export', 'report.analytics.read',
      'platformSetting.read'
    ]::TEXT[]),
    ('finance', ARRAY[
      'payout.read', 'payout.approve', 'payout.adjust', 'ledger.read',
      'ledger.audit', 'admin.dashboard.read', 'pro.read', 'admin.job.read',
      'report.export', 'report.analytics.read', 'platformSetting.read'
    ]::TEXT[]),
    ('super_admin', ARRAY[
      'identity.role.manage', 'identity.adminUser.manage', 'customer.moderate',
      'pro.application.review', 'pro.moderate', 'pro.availability.set',
      'pro.bankAccount.verify', 'catalog.manage', 'catalog.commission.set',
      'catalog.city.manage', 'booking.read', 'booking.cancel',
      'booking.force_start', 'dispatch.override', 'payment.read',
      'payment.refund', 'payment.cash.handover.confirm', 'payout.read',
      'payout.approve', 'payout.disburse', 'payout.adjust', 'incentive.manage',
      'ledger.read', 'ledger.audit', 'training.manage', 'review.moderate',
      'admin.dashboard.read', 'customer.read', 'pro.read', 'dispatch.read',
      'admin.job.read', 'admin.bulk.execute', 'report.export',
      'report.analytics.read', 'platformSetting.read',
      'platformSetting.manage'
    ]::TEXT[])
)
UPDATE "roles" AS role
SET
  "permissionCodes" = (
    SELECT COALESCE(jsonb_agg(permission ORDER BY permission), '[]'::JSONB)
    FROM (
      SELECT jsonb_array_elements_text(role."permissionCodes") AS permission
      UNION
      SELECT unnest(grants.permissions) AS permission
    ) AS merged
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM grants
WHERE role.name = grants.role_name;
