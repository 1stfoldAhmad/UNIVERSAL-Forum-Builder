import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from '../src/App';

describe('demo app (full pipeline in a browser-like DOM)', () => {
  it('boots, compiles the default form, and submits through a registered executor', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('input-name')).toBeTruthy());
    fireEvent.change(screen.getByTestId('input-name'), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByTestId('input-message'), { target: { value: 'Hello from the live preview.' } });
    await act(async () => { fireEvent.click(screen.getByTestId('submit-button')); });
    await waitFor(() => expect(screen.getByTestId('submit-success')).toBeTruthy());
    // Inspector proves a record was persisted by the registered TEST executor.
    fireEvent.click(screen.getByTestId('tab-submission'));
    await waitFor(() => expect(Number(screen.getByTestId('record-count').textContent)).toBeGreaterThanOrEqual(1));
  });

  it('switches forms and re-initializes a fresh runtime', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('input-name')).toBeTruthy());
    fireEvent.click(screen.getByTestId('pick-form-invoice'));
    await waitFor(() => expect(screen.getByTestId('add-items')).toBeTruthy());
    fireEvent.click(screen.getByTestId('add-items'));
    fireEvent.change(screen.getByTestId('input-items.0.qty'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('input-items.0.price'), { target: { value: '50' } });
    await waitFor(() => expect(screen.getByTestId('computed-total').textContent).toBe('115'));
  });

  it('cascading data sources load country then city options', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('input-name')).toBeTruthy());
    fireEvent.click(screen.getByTestId('pick-form-address'));
    await waitFor(() => expect(screen.getByTestId('input-address.country')).toBeTruthy());
    const country = screen.getByTestId('input-address.country') as HTMLSelectElement;
    await waitFor(() => expect(country.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(country, { target: { value: 'PK' } });
    await waitFor(() => {
      const city = screen.getByTestId('input-address.city') as HTMLSelectElement;
      expect(Array.from(city.options).some((o) => o.textContent === 'Rawalpindi')).toBe(true);
    });
  });
});
