-- Reverses 20260814130000_admin_slide_otp. The admin console authenticates
-- through Firebase only, so an Admin without a Firebase identity has no way
-- in at all — the row is an account nobody can use.
--
-- Removing them first is what makes the NOT NULL below possible. This is safe
-- by construction rather than by assumption: every column that records real
-- admin work is either ON DELETE SET NULL (the history survives with the
-- actor blanked) or ON DELETE RESTRICT — and a RESTRICT hit aborts this
-- migration rather than destroying a document verification or a job record.
-- If that happens, the right move is to give that admin a Firebase identity,
-- not to force the delete.
DELETE FROM "admin_users" WHERE "firebaseUid" IS NULL;

ALTER TABLE "admin_users" ALTER COLUMN "firebaseUid" SET NOT NULL;
