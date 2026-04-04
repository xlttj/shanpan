export interface ImplementsEntry {
  symbol: string;
  type: string;
}

export interface SpecFrontmatter {
  id: string;
  title: string;
  type: string;
  status: string;
  priority?: string;
  author?: string;
  created?: string | Date;
  derives_from?: string[];
  depends_on?: string[];
  defines_rules?: string[];
  implements?: ImplementsEntry[];
  tags?: string[];
}

export interface ParsedSpec {
  frontmatter: SpecFrontmatter;
  content: string;
  filePath: string;
}

export interface IndexStats {
  specs: number;
  rules: number;
  symbols: number;
  dependsOn: number;
  derivesFrom: number;
  defines: number;
  implements: number;
}
