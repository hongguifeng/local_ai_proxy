export {
  SCHEMA_VERSION_KEY,
  TRAFFIC_DB_NAME,
  configureDatabase,
  logDatabasePath,
  openLogDatabase,
  readSchemaVersion,
  runMigrations,
  type DatabaseMigration,
} from "./database.js";
