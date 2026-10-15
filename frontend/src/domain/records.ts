import type { VatScope } from './doc-types';

export type RecordKind = 'customer' | 'vendor' | 'item' | 'bank-account' | 'employee' | 'account' | 'dimension'
  | 'wht-type' | 'expense-category' | 'posting-rule' | 'numbering-series' | 'approval-rule' | 'user' | 'role'
  | 'api-key' | 'oauth-app' | 'agent-policy' | 'settlement' | 'schedule';
export type FieldKind = 'text' | 'textarea' | 'tin' | 'branch' | 'select' | 'money' | 'percent' | 'int' | 'date' | 'bool' | 'account' | 'party' | 'item';
export interface FieldCondition { key: string; equals: string | boolean }
export interface FieldSpec { key: string; kind: FieldKind; labelKey: string; required?: boolean;
  options?: { value: string; labelKey: string }[];
  /** Options the server owns: the form loads them from that endpoint. */ optionsFrom?: 'wht-types';
  showWhen?: FieldCondition; readOnlyAfterUse?: boolean; vat?: VatScope;
  /** Required when ANY of these holds. The server decides; the form only mirrors the shape. */ requiredWhen?: FieldCondition[];
  /** kind 'item': pick several. */ multiple?: boolean; defaultValue?: string | boolean }
export interface RecordColumn { key: string; labelKey: string; align?: 'start' | 'end'; kind?: 'text' | 'money' | 'bool' | 'date';
  /** The value is a code: show the label `records.options.<optionKey>.<value>`. */ optionKey?: string }
export interface RecordDescriptor { kind: RecordKind; basePath: string; titleKey: string; permissions: { read: string; manage: string };
  columns: RecordColumn[]; fields: FieldSpec[]; detail: boolean; vat?: VatScope; searchPlaceholderKey: string }
export interface RecordRow { id: string; version: number; active: boolean; inUse?: boolean; [field: string]: unknown }
