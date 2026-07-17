export {
  SCHEMA_VERSION_KEY,
  TRAFFIC_DB_NAME,
  connectLogDatabase,
  configureDatabase,
  logDatabasePath,
  openLogDatabase,
  readSchemaVersion,
  runMigrations,
  type DatabaseMigration,
} from "./database.js";
export { SCHEMA_V1_MIGRATION, SCHEMA_VERSION } from "./schema-v1.js";
