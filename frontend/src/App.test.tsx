import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from './App';
import * as client from './api/client';

vi.mock('./api/client', () => {
  let unauthorizedCb: (() => void) | null = null;
  return {
    getAuthStatus: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getProjects: vi.fn(),
    getSystemCapabilities: vi.fn(),
    getWhisperModels: vi.fn(),
    importProject: vi.fn(),
    processProject: vi.fn(),
    deleteProject: vi.fn(),
    setUnauthorizedHandler: vi.fn((cb) => {
      unauthorizedCb = cb;
    }),
    __triggerUnauthorized: () => {
      if (unauthorizedCb) unauthorizedCb();
    },
  };
});

describe('App Component — Authentication & Session Routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (client.getSystemCapabilities as any).mockResolvedValue({
      cpu_physical_cores: 8,
      cpu_logical_cores: 16,
      ram_total_gb: 16,
      cuda_available: true,
      recommended_model: 'base',
    });
    (client.getWhisperModels as any).mockResolvedValue([]);
    (client.getProjects as any).mockResolvedValue([]);
  });

  it('bypasses login immediately in local mode (auth_required: false)', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: false,
      authenticated: true,
    });

    render(<App />);

    // Initially checking
    expect(screen.getByRole('status', { name: /Connecting to server/i })).toBeInTheDocument();

    // After resolving, loads main application
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: /Deutsch Shadow/i })).not.toBeInTheDocument();
      expect(screen.getByText('Deutsch Shadow')).toBeInTheDocument();
    });

    // Shows Local badge
    expect(screen.getByText('Local')).toBeInTheDocument();
    // Does NOT show Logout button
    expect(screen.queryByRole('button', { name: /Log Out/i })).not.toBeInTheDocument();
    // Does NOT show Cloud Demo temporary storage warning
    expect(screen.queryByText(/Cloud Demo:/i)).not.toBeInTheDocument();

    // Loaded protected endpoints
    expect(client.getProjects).toHaveBeenCalledTimes(1);
    expect(client.getSystemCapabilities).toHaveBeenCalledTimes(1);
    expect(client.getWhisperModels).toHaveBeenCalledTimes(1);
  });

  it('renders login view in unauthenticated cloud mode and blocks protected API calls', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: true,
      authenticated: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Cloud Access Authentication/i)).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/Master Password/i)).toBeInTheDocument();

    // Protected API calls MUST NOT have been initiated
    expect(client.getProjects).not.toHaveBeenCalled();
    expect(client.getSystemCapabilities).not.toHaveBeenCalled();
    expect(client.getWhisperModels).not.toHaveBeenCalled();
  });

  it('renders main app with Cloud badge and Logout button when already authenticated in cloud mode', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: true,
      authenticated: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Cloud')).toBeInTheDocument();
      expect(screen.getByText(/Cloud Demo:/i)).toBeInTheDocument();
      expect(screen.getByText(/Storage is temporary/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Log Out/i })).toBeInTheDocument();
    expect(screen.queryByText(/Cloud Access Authentication/i)).not.toBeInTheDocument();

    expect(client.getProjects).toHaveBeenCalledTimes(1);
  });

  it('displays connection error screen when backend server is unreachable and allows retry', async () => {
    (client.getAuthStatus as any).mockRejectedValueOnce(
      new Error('Failed to fetch: Connection refused')
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Connection Error')).toBeInTheDocument();
    });

    expect(
      screen.getByText('Failed to fetch: Connection refused')
    ).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry Connection/i });
    expect(retryBtn).toBeInTheDocument();

    // Protected API calls not called
    expect(client.getProjects).not.toHaveBeenCalled();

    // On retry, succeed in local mode
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: false,
      authenticated: true,
    });

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('Local')).toBeInTheDocument();
    });

    expect(client.getProjects).toHaveBeenCalledTimes(1);
  });

  it('transitions from login view to main app on successful login', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: true,
      authenticated: false,
    });
    (client.login as any).mockResolvedValue({
      success: true,
      message: 'Authenticated',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Cloud Access Authentication/i)).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/Master Password/i);
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });

    fireEvent.change(input, { target: { value: 'topsecret' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Cloud')).toBeInTheDocument();
    });

    // Now protected API calls should be loaded
    expect(client.getProjects).toHaveBeenCalledTimes(1);
  });

  it('transitions back to login view when 401 unauthorized occurs', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: true,
      authenticated: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Cloud')).toBeInTheDocument();
    });

    // Simulate 401 callback triggered by API client
    act(() => {
      (client as any).__triggerUnauthorized();
    });

    await waitFor(() => {
      expect(screen.getByText(/Cloud Access Authentication/i)).toBeInTheDocument();
    });
  });

  it('calls logout API and returns to login view when Logout button is clicked', async () => {
    (client.getAuthStatus as any).mockResolvedValue({
      auth_required: true,
      authenticated: true,
    });
    (client.logout as any).mockResolvedValue({
      success: true,
      message: 'Logged out',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Log Out/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Log Out/i }));

    expect(client.logout).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByText(/Cloud Access Authentication/i)).toBeInTheDocument();
    });
  });
});
