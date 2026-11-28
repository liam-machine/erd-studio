/**
 * DbtCommandMenu — the toolbar's **dbt command** button (GitHub #378) and the
 * menu it opens: build, run or test. A pick posts `copyDbtCommand` with the
 * tables selected on the canvas (none: the whole diagram); the host puts
 * `dbt <verb> --select …` on the clipboard and says what it copied in a
 * `canvasNotice`. It runs nothing and writes no file, so it is on both the
 * Logical and the Physical tab, read-only diagrams included.
 *
 * Shown only in a dbt project: the Toolbar renders it beside Compare with
 * dbt, behind the same `logicalOnly` check. Its label gives way to the icon
 * on a narrow editor, as Compare's does (Toolbar.css, step 2).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TableFlowNode, AnnotationFlowNode } from '@erd-studio/renderer/editor';

import { useSend } from '../../hooks/useMessageBus';
import { DBT_COMMAND_VERBS, type DbtCommandVerb } from '../../../src/types/dbtCommand';
import { IconChevronDown, IconTerminal } from './toolbarIcons';
import './DbtCommandMenu.css';

/** The canvas names of the tables selected on the canvas, in canvas order. */
export function selectedTableNames(nodes: ReadonlyArray<TableFlowNode | AnnotationFlowNode>): string[] {
  return nodes
    .filter((n): n is TableFlowNode => n.type === 'model' && n.selected === true)
    .map((n) => n.data.modelName);
}

/** The menu's heading: which tables a pick copies the command for. */
export function dbtCommandScopeLabel(selected: number, total: number): string {
  if (selected > 0) return selected === 1 ? 'For the selected table' : `For the ${selected} selected tables`;
  return total === 1 ? 'For the table on this diagram' : `For the ${total} tables on this diagram`;
}

interface DbtCommandMenuProps {
  nodes: ReadonlyArray<TableFlowNode | AnnotationFlowNode>;
}

export function DbtCommandMenu({ nodes }: DbtCommandMenuProps) {
  const send = useSend();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const selected = useMemo(() => (open ? selectedTableNames(nodes) : []), [open, nodes]);
  const total = useMemo(() => (open ? nodes.filter((n) => n.type === 'model').length : 0), [open, nodes]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const copy = useCallback(
    (verb: DbtCommandVerb) => {
      const tables = selectedTableNames(nodes);
      send({ type: 'copyDbtCommand', payload: tables.length > 0 ? { verb, tables } : { verb } });
      setOpen(false);
      buttonRef.current?.focus();
    },
    [nodes, send],
  );

  return (
    <div
      className="toolbar__dropdown dbt-command"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="toolbar__dropdown-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Copy a dbt build, run or test command for the tables on this diagram"
        aria-label="dbt command"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconTerminal />
        <span className="toolbar__label">dbt command</span>
        <span className="toolbar__dropdown-arrow"><IconChevronDown size={11} /></span>
      </button>
      {open && (
        <div className="toolbar__dropdown-menu dbt-command__menu" role="menu" aria-label="Copy a dbt command">
          <div className="dbt-command__title">{dbtCommandScopeLabel(selected.length, total)}</div>
          {DBT_COMMAND_VERBS.map((verb) => (
            <button
              key={verb}
              type="button"
              className="toolbar__dropdown-item dbt-command__item"
              role="menuitem"
              onClick={() => copy(verb)}
            >
              <span className="dbt-command__verb">dbt {verb}</span>
            </button>
          ))}
          <div className="dbt-command__hint">
            Copies the command for you to paste in a terminal. Runs nothing.
          </div>
        </div>
      )}
    </div>
  );
}
