-- The manager's phone (SCRUM-94): a fourth kind of device. Safe to run again.
ALTER TABLE devices MODIFY kind ENUM('counter','kitchen','owner','manager') NOT NULL;
