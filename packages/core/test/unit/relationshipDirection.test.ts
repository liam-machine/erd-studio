import { describe, it, expect } from 'vitest';

import {
  endEvidence,
  endEvidenceFromDisplay,
  endEvidenceFromModel,
  resolveDirection,
  type DirectionVerdict,
  type EndEvidence,
} from '../../src/relationshipDirection';
import type { ColumnDef, SemanticModel } from '../../src/types/semantic';
import type { DbtColumnEvidence } from '../../src/types/display';

/** A column from a short flag string: P = primary key, N = natural key, F = declared foreign key. */
function col(spec: string): ColumnDef {
  const [name, flags = ''] = spec.split(':');
  return {
    name,
    dataType: 'INT',
    description: '',
    ...(flags.includes('P') ? { isPrimaryKey: true } : {}),
    ...(flags.includes('N') ? { isNaturalKey: true } : {}),
    ...(flags.includes('F') ? { isForeignKey: true } : {}),
  };
}
const model = (name: string, ...columns: string[]): SemanticModel => ({ name, columns: columns.map(col) });

function end(m: SemanticModel, column: string, dbt?: DbtColumnEvidence): EndEvidence {
  const e = endEvidenceFromModel(m, column);
  if (!e) throw new Error(`no column ${m.name}.${column}`);
  return dbt ? { ...e, dbt } : e;
}

// --- The models every case below is drawn from ------------------------------
const dimCustomer = model('dim_customer', 'customer_key:P', 'customer_id:N', 'name');
const fctOrder = model('fct_order', 'order_key:P', 'customer_key:F', 'amount');
const fctOrderUnflagged = model('fct_order', 'order_key:P', 'customer_key', 'amount');
const fctSales = model('fct_sales', 'date_key:P', 'product_key:P', 'store_key:P', 'qty');
const dimProduct = model('dim_product', 'product_key:P', 'sku:N');
const hubCustomer = model('hub_customer', 'customer_hk:P', 'customer_id:N', 'load_date', 'record_source');
const satCustomer = model('sat_customer', 'customer_hk:P', 'load_date:P', 'hashdiff', 'name');
const lnkOrder = model('lnk_customer_order', 'link_hk:P', 'customer_hk:F', 'order_hk:F', 'load_date');
const hubOrder = model('hub_order', 'order_hk:P', 'order_id:N');
const customer3nf = model('customer', 'id:P', 'email:N');
const order3nf = model('orders', 'id:P', 'customer_id:F');
const person = model('person', 'person_id:P', 'name');
const employee = model('employee', 'person_id:PF', 'salary');
const employeeUnflagged = model('employee', 'person_id:P', 'salary');
const student = model('student', 'student_id:P');
const course = model('course', 'course_id:P');
const enrolment = model('enrolment', 'student_id:P', 'course_id:P');
const studentTag = model('student_tag', 'student_id', 'tag');
const courseTag = model('course_tag', 'course_id', 'tag');
const staff = model('staff', 'staff_id:P', 'manager_id:F');
const staffUnflagged = model('staff', 'staff_id:P', 'manager_id');
const logA = model('log_a', 'session_id', 'payload');
const logB = model('log_b', 'session_id', 'payload');

interface Case {
  name: string;
  a: EndEvidence;
  b: EndEvidence;
  from: string;
  to: string;
  cardinality: DirectionVerdict['cardinality'];
  confidence: DirectionVerdict['confidence'];
  conflict?: boolean;
}

const CASES: Case[] = [
  {
    name: 'Kimball: a fact\'s declared foreign key to a dimension\'s key',
    a: end(dimCustomer, 'customer_key'), b: end(fctOrder, 'customer_key'),
    from: 'fct_order.customer_key', to: 'dim_customer.customer_key', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'Kimball: an unflagged fact column to a dimension\'s key (only one end known)',
    a: end(dimCustomer, 'customer_key'), b: end(fctOrderUnflagged, 'customer_key'),
    from: 'fct_order.customer_key', to: 'dim_customer.customer_key', cardinality: 'many-to-one', confidence: 'likely',
  },
  {
    name: 'a fact keyed by its dimension keys (part of a composite key)',
    a: end(dimProduct, 'product_key'), b: end(fctSales, 'product_key'),
    from: 'fct_sales.product_key', to: 'dim_product.product_key', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'a dimension\'s whole natural key is a key too',
    a: end(dimProduct, 'sku'), b: end(model('fct_return', 'sku:F'), 'sku'),
    from: 'fct_return.sku', to: 'dim_product.sku', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'Data Vault: a satellite (key = hub key + load date) to its hub',
    a: end(hubCustomer, 'customer_hk'), b: end(satCustomer, 'customer_hk'),
    from: 'sat_customer.customer_hk', to: 'hub_customer.customer_hk', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'Data Vault: a link to each of its hubs',
    a: end(hubOrder, 'order_hk'), b: end(lnkOrder, 'order_hk'),
    from: 'lnk_customer_order.order_hk', to: 'hub_order.order_hk', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: '3NF: orders.customer_id to customer.id',
    a: end(customer3nf, 'id'), b: end(order3nf, 'customer_id'),
    from: 'orders.customer_id', to: 'customer.id', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'shared primary key 1:1 with a declared foreign key',
    a: end(person, 'person_id'), b: end(employee, 'person_id'),
    from: 'employee.person_id', to: 'person.person_id', cardinality: 'one-to-one', confidence: 'certain',
  },
  {
    name: 'shared primary key 1:1 without foreign key evidence',
    a: end(person, 'person_id'), b: end(employeeUnflagged, 'person_id'),
    from: 'employee.person_id', to: 'person.person_id', cardinality: 'one-to-one', confidence: 'ambiguous',
  },
  {
    name: 'many-to-many: two composite-key columns of a bridge… and its other end',
    a: end(enrolment, 'student_id'), b: end(model('enrolment_audit', 'student_id:P', 'at:P'), 'student_id'),
    from: 'enrolment.student_id', to: 'enrolment_audit.student_id', cardinality: 'many-to-many', confidence: 'ambiguous',
  },
  {
    name: 'a bridge to one of its entities is ordinary many-to-one',
    a: end(student, 'student_id'), b: end(enrolment, 'student_id'),
    from: 'enrolment.student_id', to: 'student.student_id', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'two unique ends with no foreign key: a 1:1 either way',
    a: end(student, 'student_id'), b: end(course, 'course_id'),
    from: 'course.course_id', to: 'student.student_id', cardinality: 'one-to-one', confidence: 'ambiguous',
  },
  {
    name: 'self-reference: a declared manager_id to the key',
    a: end(staff, 'staff_id'), b: end(staff, 'manager_id'),
    from: 'staff.manager_id', to: 'staff.staff_id', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'self-reference: an unflagged manager_id to the key',
    a: end(staffUnflagged, 'manager_id'), b: end(staffUnflagged, 'staff_id'),
    from: 'staff.manager_id', to: 'staff.staff_id', cardinality: 'many-to-one', confidence: 'likely',
  },
  {
    name: 'unkeyed: no evidence at all',
    a: end(logB, 'session_id'), b: end(logA, 'session_id'),
    from: 'log_a.session_id', to: 'log_b.session_id', cardinality: 'many-to-one', confidence: 'ambiguous',
  },
  {
    name: 'unkeyed, but dbt tests one end as unique',
    a: end(logA, 'session_id', { unique: true }), b: end(logB, 'session_id'),
    from: 'log_b.session_id', to: 'log_a.session_id', cardinality: 'many-to-one', confidence: 'likely',
  },
  {
    name: 'dbt alone settles both ends: still only likely',
    a: end(studentTag, 'student_id', { relationshipsTest: true }), b: end(courseTag, 'course_id', { unique: true }),
    from: 'student_tag.student_id', to: 'course_tag.course_id', cardinality: 'many-to-one', confidence: 'likely',
  },
  {
    name: 'dbt agrees with the keys: certain stays certain',
    a: end(dimCustomer, 'customer_key', { unique: true }), b: end(fctOrder, 'customer_key', { relationshipsTest: true }),
    from: 'fct_order.customer_key', to: 'dim_customer.customer_key', cardinality: 'many-to-one', confidence: 'certain',
  },
  {
    name: 'keys versus dbt conflict: ambiguous, flagged',
    a: end(dimCustomer, 'customer_key', { inCompositeUnique: true }), b: end(fctOrder, 'customer_key'),
    from: 'dim_customer.customer_key', to: 'fct_order.customer_key', cardinality: 'many-to-one', confidence: 'ambiguous', conflict: true,
  },
  {
    name: 'both ends declared foreign keys and unkeyed: many-to-many',
    a: end(model('x', 'k:F'), 'k'), b: end(model('y', 'k:F'), 'k'),
    from: 'x.k', to: 'y.k', cardinality: 'many-to-many', confidence: 'ambiguous',
  },
  {
    name: 'a whole key that is also a declared foreign key, other end unknown',
    a: end(employee, 'person_id'), b: end(model('legacy_person', 'person_id'), 'person_id'),
    from: 'employee.person_id', to: 'legacy_person.person_id', cardinality: 'one-to-one', confidence: 'likely',
  },
];

const label = (e: { model: string; column: string }): string => `${e.model}.${e.column}`;

describe('resolveDirection — direction from evidence (#133)', () => {
  it.each(CASES)('$name', ({ a, b, from, to, cardinality, confidence, conflict }) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const verdict = resolveDirection(x, y);
      expect(label(verdict.from)).toBe(from);
      expect(label(verdict.to)).toBe(to);
      expect(verdict.cardinality).toBe(cardinality);
      expect(verdict.confidence).toBe(confidence);
      expect(verdict.conflict ?? false).toBe(conflict ?? false);
      expect(verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  it('is symmetric and never answers one-to-many', () => {
    for (const { a, b } of CASES) {
      expect(resolveDirection(a, b)).toEqual(resolveDirection(b, a));
      expect(resolveDirection(a, b).cardinality).not.toBe('one-to-many');
    }
  });

  it('explains a certain verdict in plain words', () => {
    const verdict = resolveDirection(end(dimCustomer, 'customer_key'), end(fctOrder, 'customer_key'));
    expect(verdict.reasons).toEqual([
      'fct_order.customer_key is marked as a foreign key',
      "dim_customer.customer_key is dim_customer's primary key",
    ]);
  });

  it('names both sides of a conflict', () => {
    const verdict = resolveDirection(end(dimCustomer, 'customer_key', { inCompositeUnique: true }), end(fctOrder, 'customer_key'));
    expect(verdict.reasons.join(' ')).toMatch(/primary key, but dbt tests dim_customer\.customer_key as part of a unique combination/);
  });
});

describe('endEvidence', () => {
  it('reads the stored flags, counting key columns, without case', () => {
    expect(endEvidenceFromModel(fctSales, 'PRODUCT_KEY')).toEqual({
      model: 'fct_sales', column: 'product_key', isPrimaryKey: true, isNaturalKey: false, isForeignKeyDeclared: false,
      pkColumnCount: 3, nkColumnCount: 0,
    });
    expect(endEvidenceFromModel(fctSales, 'nope')).toBeUndefined();
  });

  it('reads only the declared flag of a displayed column, never the FK badge', () => {
    const displayed = {
      name: 'dim_customer',
      columns: [
        { name: 'customer_key', isPrimaryKey: true, isForeignKey: true, isNaturalKey: false },
        { name: 'x', isPrimaryKey: false, isForeignKey: true, isForeignKeyDeclared: true, isNaturalKey: false, dbtEvidence: { unique: true } },
      ],
    };
    expect(endEvidenceFromDisplay(displayed, 'customer_key')?.isForeignKeyDeclared).toBe(false);
    expect(endEvidenceFromDisplay(displayed, 'x')).toMatchObject({ isForeignKeyDeclared: true, dbt: { unique: true } });
  });

  it('takes any column shape with a caller-chosen declared flag', () => {
    const e = endEvidence('m', [{ name: 'k', fk: true }], 'k', (c) => c.fk);
    expect(e?.isForeignKeyDeclared).toBe(true);
  });
});
