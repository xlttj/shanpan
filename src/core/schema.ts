export const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE Spec (
    id STRING PRIMARY KEY,
    title STRING,
    type STRING,
    status STRING,
    priority STRING,
    author STRING,
    created DATE,
    description STRING,
    acceptance_criteria STRING
  )`,
  `CREATE NODE TABLE BusinessRule (
    id STRING PRIMARY KEY,
    title STRING,
    type STRING,
    status STRING,
    description STRING
  )`,
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
  `CREATE NODE TABLE Ref (
    id STRING PRIMARY KEY
  )`,
  `CREATE REL TABLE REFERENCES (FROM Spec TO Ref)`,
  `CREATE REL TABLE DEFINES (FROM Spec TO BusinessRule)`,
  `CREATE REL TABLE GROUP CONSTRAINS (
    FROM BusinessRule TO Spec,
    FROM BusinessRule TO BusinessRule
  )`,
  `CREATE REL TABLE GROUP IMPLEMENTS (
    FROM CodeSymbol TO Spec,
    FROM CodeSymbol TO BusinessRule,
    FROM File TO Spec,
    FROM File TO BusinessRule,
    confidence FLOAT DEFAULT 1.0,
    verified_at TIMESTAMP,
    verified_by STRING
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
  'Spec', 'BusinessRule', 'CodeSymbol', 'File', 'Ref',
  'REFERENCES', 'DEFINES', 'CONSTRAINS', 'IMPLEMENTS', 'CONTAINS', 'CALLS',
  'Record', 'ABOUT', 'SUPERSEDES',
];

/** Tables to drop in dependency order (edges before nodes). */
export const DROP_ORDER = [
  'SUPERSEDES',
  'ABOUT',
  'CALLS',
  'IMPLEMENTS',
  'CONTAINS',
  'CONSTRAINS',
  'DEFINES',
  'REFERENCES',
  'Record',
  'CodeSymbol',
  'BusinessRule',
  'Ref',
  'Spec',
  'File',
];
