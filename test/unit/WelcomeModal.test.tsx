// @vitest-environment jsdom
/**
 * WelcomeModal — the canvas's first-open dialog. "Watch the short tour"
 * posts `openGettingStarted` (the host opens the Welcome panel) and leaves the
 * modal open; "Get Started" persists the dismissal and closes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

const setWelcomeModalOpen = vi.hoisted(() => vi.fn());
const storeState = vi.hoisted(() => ({ welcomeModalOpen: true, setWelcomeModalOpen }) as Record<string, unknown>);
vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: Record<string, unknown>) => unknown) => selector(storeState),
}));

// Panel needs a React Flow store; the modal only uses it for placement.
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: unknown; className?: string }) => (
    <div className={className}>{children as never}</div>
  ),
}));

import { WelcomeModal } from '../../webview/components/WelcomeModal/WelcomeModal';

afterEach(() => {
  cleanup();
  send.mockClear();
  setWelcomeModalOpen.mockClear();
});

describe('WelcomeModal', () => {
  it('"Watch the short tour" posts openGettingStarted and keeps the modal open', () => {
    const { getByText } = render(<WelcomeModal />);
    fireEvent.click(getByText('Watch the short tour'));
    expect(send).toHaveBeenCalledWith({ type: 'openGettingStarted' });
    expect(setWelcomeModalOpen).not.toHaveBeenCalled();
  });

  it('"Get Started" still dismisses through useSend', () => {
    const { getByText } = render(<WelcomeModal />);
    fireEvent.click(getByText('Get Started'));
    expect(send).toHaveBeenCalledWith({ type: 'dismissWelcome' });
    expect(setWelcomeModalOpen).toHaveBeenCalledWith(false);
  });
});
