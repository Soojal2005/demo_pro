-- New Admin accounts authenticate through the shared Slide phone OTP flow.
-- Keep existing Firebase links nullable for backwards compatibility.
ALTER TABLE "admin_users" ALTER COLUMN "firebaseUid" DROP NOT NULL;
