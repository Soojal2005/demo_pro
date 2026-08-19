CREATE TABLE "platform_setting_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settingId" UUID,
  "key" TEXT NOT NULL,
  "cityId" UUID,
  "action" TEXT NOT NULL,
  "previousValue" TEXT,
  "newValue" TEXT,
  "reason" TEXT NOT NULL,
  "impactConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "changedByAdminId" UUID,
  CONSTRAINT "platform_setting_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_setting_revisions_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "platform_settings"("id") ON DELETE SET NULL,
  CONSTRAINT "platform_setting_revisions_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL,
  CONSTRAINT "platform_setting_revisions_changedByAdminId_fkey" FOREIGN KEY ("changedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL
);
CREATE INDEX "platform_setting_revisions_key_cityId_createdAt_idx" ON "platform_setting_revisions"("key", "cityId", "createdAt");
CREATE INDEX "platform_setting_revisions_changedByAdminId_createdAt_idx" ON "platform_setting_revisions"("changedByAdminId", "createdAt");

CREATE TABLE "ui_configs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "appType" TEXT NOT NULL DEFAULT 'customer',
  "screenKey" TEXT NOT NULL DEFAULT 'home',
  "targetKey" TEXT NOT NULL,
  "cityId" UUID,
  "userSegment" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "jsonTree" JSONB NOT NULL,
  "minAppVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "cdnKey" TEXT,
  "cdnUrl" TEXT,
  "createdByAdminId" UUID,
  "publishedByAdminId" UUID,
  "publishedAt" TIMESTAMP(3),
  "cacheInvalidatedAt" TIMESTAMP(3),
  "publicationReason" TEXT,
  CONSTRAINT "ui_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ui_configs_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT,
  CONSTRAINT "ui_configs_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "ui_configs_publishedByAdminId_fkey" FOREIGN KEY ("publishedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "ui_configs_targetKey_version_key" ON "ui_configs"("targetKey", "version");
CREATE UNIQUE INDEX "ui_configs_one_published_target_idx" ON "ui_configs"("targetKey") WHERE "status" = 'published';
CREATE INDEX "ui_configs_targetKey_status_version_idx" ON "ui_configs"("targetKey", "status", "version");
CREATE INDEX "ui_configs_cityId_userSegment_status_idx" ON "ui_configs"("cityId", "userSegment", "status");

INSERT INTO "platform_settings" ("id", "createdAt", "updatedAt", "key", "cityId", "value", "description")
SELECT gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, v.key, NULL, v.value, v.description
FROM (VALUES
  ('no_start.graceWindowMinutes', '15', 'Minutes after arrival before a no-start incident.'),
  ('assignment.ackWindowSeconds', '120', 'Seconds a Pro has to acknowledge an assignment.'),
  ('rotation.cooldownJobs', '2', 'Recent household jobs considered by Pro rotation.'),
  ('dispatch.candidatePoolSize', '10', 'Maximum candidate pool size.'),
  ('review.maxPhotos', '3', 'Maximum review photos.'),
  ('dispatch.ratingPriorMean', '4', 'Bayesian prior rating mean.'),
  ('dispatch.ratingPriorWeight', '5', 'Bayesian prior rating weight.')
) AS v(key, value, description)
WHERE NOT EXISTS (
  SELECT 1 FROM "platform_settings" p WHERE p."key" = v.key AND p."cityId" IS NULL
);

UPDATE "roles"
SET "permissionCodes" = COALESCE("permissionCodes", '[]'::jsonb) || '["uiConfig.read","uiConfig.manage","uiConfig.publish"]'::jsonb
WHERE "name" IN ('ops', 'super_admin');
