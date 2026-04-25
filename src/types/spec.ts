export interface ImplementsEntry {
  symbol: string;
  type: string;
}

export interface GivenWhenThen {
  given: string;
  when: string;
  then: string;
}

export interface SpecFrontmatter {
  title: string;
  type: string;
  status: string;
  priority?: string;
  author?: string;
  created?: string | Date;
  defines_rules?: string[];
  implements?: ImplementsEntry[];
  acceptance_criteria?: GivenWhenThen[];
}

export interface ParsedSpec {
  id: string;
  frontmatter: SpecFrontmatter;
  content: string;
  filePath: string;
}

export interface IndexStats {
  specs: number;
  rules: number;
  symbols: number;
  defines: number;
  implements: number;
}
