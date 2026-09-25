import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/utils';

const logs = [];

function Probe({ dynamic }) {
  const [id, setId] = useState(dynamic ? null : 1);
  const { error } = useQuery({
    queryKey: ['probe', dynamic ? 'dyn' : 'fix', id],
    queryFn: () => Promise.reject(new Error('BOOM')),
    enabled: dynamic ? !!id : true,
    onError: (e) => logs.push(`onError:${e.message}:${dynamic ? 'dyn' : 'fix'}`),
  });
  return (
    <div>
      <button onClick={() => setId(1)}>go</button>
      <div data-testid="out">{error ? 'error' : 'idle'}</div>
    </div>
  );
}

describe('probe', () => {
  it('enabled al montar', async () => {
    renderWithProviders(<Probe dynamic={false} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('error'));
  });

  it('enabled dinámico', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<Probe dynamic />);
    await user.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('error'));
  });

  it('log final', () => {
    console.log('LOGS:', JSON.stringify(logs));
    expect(true).toBe(true);
  });
});
