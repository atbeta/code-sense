import type { Detector } from './base.js';
import { ImportStatementDetector } from './import-statement.js';
import { CallExpressionDetector } from './call-expression.js';
import { NewExpressionDetector } from './new-expression.js';
import { MemberExpressionDetector } from './member-expression.js';
import { ImportExpressionDetector } from './dynamic-import.js';
import { ExportDefaultDetector } from './export-default.js';
import { AnnotationDetector } from './annotation.js';
import { TemplateElementDetector } from './template-element.js';
import { CompilerMacroDetector } from './compiler-macro.js';

const registry = new Map<string, Detector>();

registry.set('import_statement', ImportStatementDetector);
registry.set('call_expression', CallExpressionDetector);
registry.set('new_expression', NewExpressionDetector);
registry.set('member_expression', MemberExpressionDetector);
registry.set('import_expression', ImportExpressionDetector);
registry.set('export_default', ExportDefaultDetector);
registry.set('annotation', AnnotationDetector);
registry.set('template_element', TemplateElementDetector);
registry.set('compiler_macro', CompilerMacroDetector);

export function getDetector(name: string): Detector | undefined {
  return registry.get(name);
}

export function listDetectors(): string[] {
  return Array.from(registry.keys());
}

export { AnnotationDetector, TemplateElementDetector, CompilerMacroDetector };
