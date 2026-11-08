import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginView } from './LoginView';
import * as client from '../api/client';

vi.mock('../api/client', () => ({
  login: vi.fn(),
}));

describe('LoginView Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders login form elements with accessible labels and attributes', () => {
    render(<LoginView onLoginSuccess={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 1, name: /Deutsch Shadow/i })).toBeInTheDocument();
    expect(screen.getByText(/Cloud Access Authentication/i)).toBeInTheDocument();

    const input = screen.getByLabelText(/Master Password/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');

    const submitBtn = screen.getByRole('button', { name: /Sign In/i });
    expect(submitBtn).toBeInTheDocument();
    expect(submitBtn).toBeDisabled(); // Disabled when empty
  });

  it('enables submit button only when non-empty password is typed', () => {
    render(<LoginView onLoginSuccess={vi.fn()} />);

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    expect(submitBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: '   ' } });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: 'secret123' } });
    expect(submitBtn).toBeEnabled();
  });

  it('preserves password exactly with leading and trailing spaces when submitted', async () => {
    const onLoginSuccess = vi.fn();
    (client.login as any).mockResolvedValue({
      success: true,
      message: 'Authenticated',
    });

    render(<LoginView onLoginSuccess={onLoginSuccess} />);

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    const passwordWithSpaces = '  secret passphrase with spaces  ';
    fireEvent.change(input, { target: { value: passwordWithSpaces } });
    fireEvent.click(submitBtn);

    expect(client.login).toHaveBeenCalledWith(passwordWithSpaces);

    await waitFor(() => {
      expect(onLoginSuccess).toHaveBeenCalledTimes(1);
    });

    // Password input is cleared
    expect(input).toHaveValue('');

    // Crucial security invariant: localStorage and sessionStorage must be completely untouched
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('displays loading indicator and disables inputs during authentication request', async () => {
    let resolveLogin: (val: any) => void = () => {};
    const loginPromise = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    (client.login as any).mockReturnValue(loginPromise);

    render(<LoginView onLoginSuccess={vi.fn()} />);

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    fireEvent.change(input, { target: { value: 'password123' } });
    fireEvent.click(submitBtn);

    expect(screen.getByText(/Signing in\.\.\./i)).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(submitBtn).toBeDisabled();

    resolveLogin({ success: true, message: 'Authenticated' });
    await waitFor(() => {
      expect(screen.queryByText(/Signing in\.\.\./i)).not.toBeInTheDocument();
    });
  });

  it('displays error alert on 401 invalid credentials and clears password', async () => {
    const onLoginSuccess = vi.fn();
    (client.login as any).mockRejectedValue(
      new Error('Invalid authentication credentials')
    );

    render(<LoginView onLoginSuccess={onLoginSuccess} />);

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    fireEvent.change(input, { target: { value: 'wrong_password' } });
    fireEvent.click(submitBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid authentication credentials');
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('displays error alert on 429 rate limit error', async () => {
    (client.login as any).mockRejectedValue(
      new Error('Too many failed attempts. Try again in 60 seconds.')
    );

    render(<LoginView onLoginSuccess={vi.fn()} />);

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    fireEvent.change(input, { target: { value: 'password' } });
    fireEvent.click(submitBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many failed attempts. Try again in 60 seconds.');
  });
});
