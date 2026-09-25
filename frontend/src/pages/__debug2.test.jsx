import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/utils';

function Probe() {
  const [id, setId] = useState(null);
  const { data, error } = useQuery({
    queryKey: ['probe', id],
    queryFn: () => Promise.reject(new Error('BOOM')),
    enabled: !!id,
    onError: () => console.log('ONERROR FIRED for', id),
  });
  return (
    <div>
      <button onClick={() => setId(1)}>go</button>
      <div data-testid="out">{error ? 'error:' + error.message : data ? 'data' : 'idle'}</div>
    </div>
  );
}

describe('probe', () => {
  it('onError de useQuery con enabled dinámico', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(<Probe />);
    await user.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('error:BOOM'));
  });
});
