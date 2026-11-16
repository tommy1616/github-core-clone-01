// A small GraphQL lexer and executable-document parser: operations, variables, fields with aliases
// and arguments, fragments, inline fragments and directives. Every value literal kind gh and
// github-mcp-server send is represented.

export interface SourceLocation {
  readonly line: number;
  readonly column: number;
}

export type TypeNode =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'list'; readonly ofType: TypeNode }
  | { readonly kind: 'non_null'; readonly ofType: TypeNode };

export type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

export interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

export interface DirectiveNode {
  readonly name: string;
  readonly arguments: readonly ArgumentNode[];
}

export interface VariableDefinitionNode {
  readonly name: string;
  readonly type: TypeNode;
  readonly defaultValue?: ValueNode;
}

export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias?: string;
  readonly arguments: readonly ArgumentNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet?: SelectionSetNode;
  readonly loc: SourceLocation;
}

export interface FragmentSpreadNode {
  readonly kind: 'fragment_spread';
  readonly name: string;
  readonly directives: readonly DirectiveNode[];
  readonly loc: SourceLocation;
}

export interface InlineFragmentNode {
  readonly kind: 'inline_fragment';
  readonly typeCondition?: string;
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
  readonly loc: SourceLocation;
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface SelectionSetNode {
  readonly selections: readonly SelectionNode[];
}

export interface OperationDefinitionNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name?: string;
  readonly variableDefinitions: readonly VariableDefinitionNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
  readonly loc: SourceLocation;
}

export interface FragmentDefinitionNode {
  readonly kind: 'fragment';
  readonly name: string;
  readonly typeCondition: string;
  readonly directives: readonly DirectiveNode[];
  readonly selectionSet: SelectionSetNode;
  readonly loc: SourceLocation;
}

export interface DocumentNode {
  readonly kind: 'document';
  readonly operations: readonly OperationDefinitionNode[];
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>;
}

export class GraphQLSyntaxError extends Error {
  readonly locations: SourceLocation[];

  constructor(message: string, location: SourceLocation) {
    super(message);
    this.name = 'GraphQLSyntaxError';
    this.locations = [location];
  }
}

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'block_string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly loc: SourceLocation;
}

const PUNCTUATION = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function isNameStart(char: string): boolean {
  return char === '_' || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z');
}

function isNameContinue(char: string): boolean {
  return isNameStart(char) || (char >= '0' && char <= '9');
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

class Lexer {
  private readonly source: string;
  private index = 0;
  private line = 1;
  private column = 1;

  constructor(source: string) {
    this.source = source;
  }

  private loc(): SourceLocation {
    return { line: this.line, column: this.column };
  }

  private advance(count = 1): void {
    for (let step = 0; step < count; step += 1) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === '\n') {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
    }
  }

  private skipIgnored(): void {
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) return;
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',' || char === '\uFEFF') {
        this.advance();
        continue;
      }
      if (char === '#') {
        while (this.index < this.source.length && this.source[this.index] !== '\n') this.advance();
        continue;
      }
      return;
    }
  }

  next(): Token {
    this.skipIgnored();
    const loc = this.loc();
    const char = this.source[this.index];
    if (char === undefined) return { kind: 'eof', value: '', loc };
    if (char === '.' && this.source.startsWith('...', this.index)) {
      this.advance(3);
      return { kind: 'punct', value: '...', loc };
    }
    if (PUNCTUATION.has(char)) {
      this.advance();
      return { kind: 'punct', value: char, loc };
    }
    if (char === '"') {
      if (this.source.startsWith('"""', this.index)) return this.blockString(loc);
      return this.string(loc);
    }
    if (isDigit(char) || (char === '-' && isDigit(this.source[this.index + 1] ?? ''))) return this.number(loc);
    if (isNameStart(char)) {
      let value = '';
      while (this.index < this.source.length && isNameContinue(this.source[this.index] as string)) {
        value += this.source[this.index];
        this.advance();
      }
      return { kind: 'name', value, loc };
    }
    throw new GraphQLSyntaxError(`Unexpected character ${JSON.stringify(char)}`, loc);
  }

  private string(loc: SourceLocation): Token {
    this.advance();
    let value = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index] as string;
      if (char === '"') {
        this.advance();
        return { kind: 'string', value, loc };
      }
      if (char === '\n' || char === '\r') throw new GraphQLSyntaxError('Unterminated string', loc);
      if (char === '\\') {
        this.advance();
        const escape = this.source[this.index];
        if (escape === undefined) break;
        this.advance();
        if (escape === 'u') {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('Bad unicode escape', this.loc());
          value += String.fromCharCode(parseInt(hex, 16));
          this.advance(4);
          continue;
        }
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        const replacement = escapes[escape];
        if (replacement === undefined) throw new GraphQLSyntaxError(`Bad escape \\${escape}`, this.loc());
        value += replacement;
        continue;
      }
      value += char;
      this.advance();
    }
    throw new GraphQLSyntaxError('Unterminated string', loc);
  }

  private blockString(loc: SourceLocation): Token {
    this.advance(3);
    let value = '';
    while (this.index < this.source.length) {
      if (this.source.startsWith('"""', this.index)) {
        this.advance(3);
        return { kind: 'block_string', value: value.replace(/\r\n?/g, '\n'), loc };
      }
      if (this.source.startsWith('\\"""', this.index)) {
        value += '"""';
        this.advance(4);
        continue;
      }
      const char = this.source[this.index] as string;
      value += char;
      this.advance();
    }
    throw new GraphQLSyntaxError('Unterminated block string', loc);
  }

  private number(loc: SourceLocation): Token {
    let text = '';
    if (this.source[this.index] === '-') {
      text += '-';
      this.advance();
    }
    while (isDigit(this.source[this.index] ?? '')) {
      text += this.source[this.index];
      this.advance();
    }
    let isFloat = false;
    if (this.source[this.index] === '.') {
      isFloat = true;
      text += '.';
      this.advance();
      while (isDigit(this.source[this.index] ?? '')) {
        text += this.source[this.index];
        this.advance();
      }
    }
    const exponent = this.source[this.index];
    if (exponent === 'e' || exponent === 'E') {
      isFloat = true;
      text += exponent;
      this.advance();
      const sign = this.source[this.index];
      if (sign === '+' || sign === '-') {
        text += sign;
        this.advance();
      }
      while (isDigit(this.source[this.index] ?? '')) {
        text += this.source[this.index];
        this.advance();
      }
    }
    return { kind: isFloat ? 'float' : 'int', value: text, loc };
  }
}

class Parser {
  private readonly lexer: Lexer;
  private current: Token;

  constructor(source: string) {
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  private advance(): Token {
    const token = this.current;
    this.current = this.lexer.next();
    return token;
  }

  private isPunct(value: string): boolean {
    return this.current.kind === 'punct' && this.current.value === value;
  }

  private isName(value: string): boolean {
    return this.current.kind === 'name' && this.current.value === value;
  }

  private expectPunct(value: string): Token {
    if (!this.isPunct(value)) throw new GraphQLSyntaxError(`Expected ${JSON.stringify(value)}, got ${JSON.stringify(this.current.value || this.current.kind)}`, this.current.loc);
    return this.advance();
  }

  private expectName(): string {
    if (this.current.kind !== 'name') throw new GraphQLSyntaxError(`Expected a name, got ${JSON.stringify(this.current.value || this.current.kind)}`, this.current.loc);
    return this.advance().value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationDefinitionNode[] = [];
    const fragments = new Map<string, FragmentDefinitionNode>();
    while (this.current.kind !== 'eof') {
      if (this.isName('fragment')) {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { kind: 'document', operations, fragments };
  }

  private parseOperation(): OperationDefinitionNode {
    const loc = this.current.loc;
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | undefined;
    if (this.current.kind === 'name' && (this.isName('query') || this.isName('mutation') || this.isName('subscription'))) {
      operation = this.advance().value as 'query' | 'mutation' | 'subscription';
      if (this.current.kind === 'name') name = this.expectName();
    }
    const variableDefinitions: VariableDefinitionNode[] = [];
    if (this.isPunct('(')) {
      this.advance();
      while (!this.isPunct(')')) {
        this.expectPunct('$');
        const variableName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.isPunct('=')) {
          this.advance();
          defaultValue = this.parseValue();
        }
        this.parseDirectives();
        variableDefinitions.push(defaultValue === undefined ? { name: variableName, type } : { name: variableName, type, defaultValue });
      }
      this.expectPunct(')');
    }
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return name === undefined
      ? { kind: 'operation', operation, variableDefinitions, directives, selectionSet, loc }
      : { kind: 'operation', operation, name, variableDefinitions, directives, selectionSet, loc };
  }

  private parseFragment(): FragmentDefinitionNode {
    const loc = this.current.loc;
    this.advance();
    const name = this.expectName();
    if (!this.isName('on')) throw new GraphQLSyntaxError('A fragment needs an "on" type condition', this.current.loc);
    this.advance();
    const typeCondition = this.expectName();
    const directives = this.parseDirectives();
    const selectionSet = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, directives, selectionSet, loc };
  }

  private parseSelectionSet(): SelectionSetNode {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return { selections };
  }

  private parseSelection(): SelectionNode {
    const loc = this.current.loc;
    if (this.isPunct('...')) {
      this.advance();
      if (this.isName('on')) {
        this.advance();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inline_fragment', typeCondition, directives, selectionSet, loc };
      }
      if (this.isPunct('{')) {
        const directives: DirectiveNode[] = [];
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inline_fragment', directives, selectionSet, loc };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'fragment_spread', name, directives, loc };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | undefined;
    if (this.isPunct(':')) {
      this.advance();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : undefined;
    return selectionSet === undefined
      ? { kind: 'field', name, alias, arguments: args, directives, loc }
      : { kind: 'field', name, alias, arguments: args, directives, selectionSet, loc };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.isPunct('(')) return args;
    this.advance();
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.isPunct('@')) {
      this.advance();
      const name = this.expectName();
      directives.push({ name, arguments: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.current;
    if (token.kind === 'punct' && token.value === '$') {
      this.advance();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.advance();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.advance();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'string' || token.kind === 'block_string') {
      this.advance();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.advance();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (this.isPunct('[')) {
      this.advance();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (this.isPunct('{')) {
      this.advance();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLSyntaxError(`Expected a value, got ${JSON.stringify(token.value || token.kind)}`, token.loc);
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.isPunct('[')) {
      this.advance();
      const ofType = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', ofType };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.isPunct('!')) {
      this.advance();
      type = { kind: 'non_null', ofType: type };
    }
    return type;
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

/** A value literal with variables substituted; objects and lists become plain JS values. */
export function valueToJs(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueToJs(value, variables));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = valueToJs(field.value, variables);
      return object;
    }
  }
}

/** The arguments of a field or directive as a plain object. */
export function argumentsToJs(
  args: readonly ArgumentNode[],
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const argument of args) out[argument.name] = valueToJs(argument.value, variables);
  return out;
}
