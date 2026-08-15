-- The service-start code stops being an SMS.
--
-- It used to be issued through the same Slide provider as login, which meant
-- the code itself never reached this database: only "startOtpProviderRef" was
-- stored. The customer app therefore had nothing to display, every job start
-- cost a message, and a customer with no phone on file could not start a job
-- at all.
--
-- Both columns are additive and nullable, so existing rows and the currently
-- deployed release are unaffected. "startOtpProviderRef" is deliberately left
-- in place: historical bookings keep their audit trail, and nothing writes it
-- from here on.
-- IF NOT EXISTS so this is safe to re-run against a database whose migration
-- history has drifted from the repo, which this one's has.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "startOtpCode" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "startOtpIssuedAt" TIMESTAMP(3);
