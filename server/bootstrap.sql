-- Run ONCE per PC, as the MySQL admin (the only step that needs the admin password):
--   sudo mysql < server/bootstrap.sql        (Linux)
--   mysql -u root -p < server/bootstrap.sql  (Windows)
-- Replace both passwords first (docs/server-setup.md). After this, every table change is
-- `npm run server:migrate`, run as pos_migrate; the app itself runs as the limited pos_app.

CREATE DATABASE IF NOT EXISTS cheesybeez CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- The app: gets exactly the rights each migration grants it, nothing more.
CREATE USER IF NOT EXISTS 'pos_app'@'localhost' IDENTIFIED BY '<app password>';

-- Structure changes only (migrations). It can do anything inside this one database, including
-- granting pos_app its rights, so its password lives apart from the app's (server/.env.migrate).
CREATE USER IF NOT EXISTS 'pos_migrate'@'localhost' IDENTIFIED BY '<migrate password>';
GRANT ALL PRIVILEGES ON cheesybeez.* TO 'pos_migrate'@'localhost' WITH GRANT OPTION;
