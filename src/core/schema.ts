export const SCHEMA_STATEMENTS = [
  `CREATE NODE TABLE Spec (
    id STRING PRIMARY KEY,
    title STRING,
    type STRING,
    status STRING,
    priority STRING,
    author STRING,
    created DATE,
    description STRING
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
  `CREATE REL TABLE DEPENDS_ON (FROM Spec TO Spec)`,
  `CREATE REL TABLE DERIVES_FROM (FROM Spec TO Spec)`,
  `CREATE REL TABLE DEFINES (FROM Spec TO BusinessRule)`,
  `CREATE REL TABLE GROUP CONSTRAINS (
    FROM BusinessRule TO Spec,
    FROM BusinessRule TO BusinessRule
  )`,
  `CREATE REL TABLE GROUP IMPLEMENTS (
    FROM CodeSymbol TO Spec,
    FROM CodeSymbol TO BusinessRule,
    confidence FLOAT DEFAULT 1.0,
    verified_at TIMESTAMP,
    verified_by STRING
  )`,
];

/** Tables to drop in dependency order (edges before nodes) */
export const DROP_ORDER = [
  'IMPLEMENTS',
  'CONSTRAINS',
  'DEFINES',
  'DERIVES_FROM',
  'DEPENDS_ON',
  'CodeSymbol',
  'BusinessRule',
  'Spec',
];
