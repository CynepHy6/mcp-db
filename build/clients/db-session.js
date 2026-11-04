import { withMysqlSession } from "./mysql-session.js";
import { withPostgresSession } from "./postgres-session.js";
export const runSession = (conn, options, work) => conn.db_type === "mysql" ? withMysqlSession(conn, options, work) : withPostgresSession(conn, options, work);
