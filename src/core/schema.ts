export const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE CodeSymbol (
    id STRING PRIMARY KEY,
    fqn STRING,
    symbol_type STRING,
    file_path STRING,
    line_start INT64,
    line_end INT64,
    language STRING
  )`,
  `CREATE NODE TABLE File (
    id   STRING PRIMARY KEY,
    path STRING,
    ext  STRING,
    kind STRING
  )`,
  `CREATE REL TABLE GROUP CONTAINS (
    FROM File TO CodeSymbol,
    FROM CodeSymbol TO CodeSymbol
  )`,
  `CREATE REL TABLE CALLS (
    FROM CodeSymbol TO CodeSymbol,
    call_kind STRING
  )`,
  // Knowledge records. The wire format uses short keys to save context bytes;
  // the graph uses full names because queries are written by humans and agents,
  // not stored per-row. The indexer translates between the two.
  `CREATE NODE TABLE Record (
    id STRING PRIMARY KEY,
    kind STRING,
    claim STRING,
    because STRING,
    given STRING,
    when_ STRING,
    then_ STRING,
    ref STRING,
    provenance STRING,
    provenance_kind STRING,
    ts TIMESTAMP,
    live BOOLEAN
  )`,
  `CREATE REL TABLE GROUP ABOUT (
    FROM Record TO CodeSymbol,
    FROM Record TO File
  )`,
  `CREATE REL TABLE SUPERSEDES (FROM Record TO Record)`,
];

/**
 * Table name for each statement above, in the same order. Lets `ensureSchema`
 * create only what is missing, so a database built by an older version gains
 * new tables instead of needing a full rebuild.
 */
export const SCHEMA_TABLE_NAMES = [
  'CodeSymbol', 'File', 'CONTAINS', 'CALLS',
  'Record', 'ABOUT', 'SUPERSEDES',
];

/**
 * Idempotent column additions for tables that already exist in an older
 * database. Each is run inside a try/catch — a fresh table already has the
 * column (the CREATE above includes it) and the ALTER simply fails, which is
 * fine. `ensureSchema` only creates a *missing* table, so an existing Record
 * table would never gain a new column without this.
 */
export const SCHEMA_MIGRATIONS = [
  'ALTER TABLE Record ADD ref STRING',
];

/** Tables to drop in dependency order (edges before nodes). */
export const DROP_ORDER = [
  'SUPERSEDES',
  'ABOUT',
  'CALLS',
  'CONTAINS',
  'Record',
  'CodeSymbol',
  'File',
];

/**
 * Node and relationship tables written by earlier, spec-based versions.
 * Dropped on open so an existing database sheds them instead of carrying
 * dead tables forever. Edges first — Kuzu refuses to drop a node table that
 * still has relationships attached.
 */
export const LEGACY_TABLES = [
  'IMPLEMENTS',
  'DEFINES',
  'CONSTRAINS',
  'REFERENCES',
  'Spec',
  'BusinessRule',
  'Ref',
];
