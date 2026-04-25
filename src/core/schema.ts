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
];

/** Tables to drop in dependency order (edges before nodes). */
export const DROP_ORDER = [
  'CALLS',
  'IMPLEMENTS',
  'CONTAINS',
  'CONSTRAINS',
  'DEFINES',
  'REFERENCES',
  'CodeSymbol',
  'BusinessRule',
  'Ref',
  'Spec',
  'File',
];
