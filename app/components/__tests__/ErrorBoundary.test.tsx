import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { COOKIE_NAME, DENIED, writeConsent } from '@/lib/cookie-consent';

const captureRenderError = vi.fn();

vi.mock('@/lib/sentry', () => ({
  captureRenderError: (...args: unknown[]) => captureRenderError(...args),
}));

function Boom(): null {
  throw new Error('render-boom');
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: test cleanup of the consent cookie
  document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/`;
  vi.restoreAllMocks();
  captureRenderError.mockReset();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('forwards consented render errors to Sentry and shows the fallback', async () => {
    writeConsent({ ...DENIED, analytics: true });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    await waitFor(() => expect(captureRenderError).toHaveBeenCalledTimes(1));
    expect(captureRenderError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('shows the fallback without reporting errors when analytics is denied', async () => {
    writeConsent(DENIED);
    await act(async () => {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(captureRenderError).not.toHaveBeenCalled();
  });
});
