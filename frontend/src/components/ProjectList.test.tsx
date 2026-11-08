import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectList } from './ProjectList';
import { ProjectSummary } from '../api/client';

describe('ProjectList Component', () => {
  it('renders empty state when no projects exist', () => {
    render(
      <ProjectList
        projects={[]}
        isLoading={false}
        onSelectProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
      />
    );

    expect(screen.getByText('No Media Imported')).toBeInTheDocument();
    expect(screen.getByText('Import First File')).toBeInTheDocument();
  });

  it('renders project cards with metadata and handles clicks', () => {
    const mockProjects: ProjectSummary[] = [
      {
        id: 'proj-123',
        title: 'German News Broadcast',
        original_filename: 'tagesschau.mp4',
        media_type: 'video',
        duration_seconds: 125,
        whisper_model: 'base',
        status: 'ready',
        segments_count: 24,
        created_at: '2026-10-27T10:00:00Z',
        updated_at: '2026-10-27T10:05:00Z',
      },
    ];

    const onSelect = vi.fn();
    const onDelete = vi.fn();

    render(
      <ProjectList
        projects={mockProjects}
        isLoading={false}
        onSelectProject={onSelect}
        onDeleteProject={onDelete}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
      />
    );

    expect(screen.getByText('German News Broadcast')).toBeInTheDocument();
    expect(screen.getByText('tagesschau.mp4')).toBeInTheDocument();
    expect(screen.getByText('02:05')).toBeInTheDocument();
    expect(screen.getByText('24 clips')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    // Trigger select
    fireEvent.click(screen.getByText('German News Broadcast'));
    expect(onSelect).toHaveBeenCalledWith('proj-123');

    // Trigger delete
    const deleteBtn = screen.getByTitle('Delete project');
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith(mockProjects[0]);
  });

  it('renders persistent cloud storage warning and cloud subtitle when authRequired is true', () => {
    const mockProjects: ProjectSummary[] = [
      {
        id: 'proj-123',
        title: 'Cloud Project',
        original_filename: 'audio.mp3',
        media_type: 'audio',
        duration_seconds: 60,
        whisper_model: 'tiny',
        status: 'ready',
        segments_count: 5,
        created_at: '2026-10-27T10:00:00Z',
        updated_at: '2026-10-27T10:05:00Z',
      },
    ];

    render(
      <ProjectList
        projects={mockProjects}
        isLoading={false}
        onSelectProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
        authRequired={true}
      />
    );

    // Warning is visible
    expect(screen.getByText(/Cloud Demo:/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Storage is temporary\. Your uploaded media, transcripts, recordings, and edits may be lost/i)
    ).toBeInTheDocument();

    // Subtitle indicates temporary cloud session
    expect(screen.getByText(/1 project in temporary cloud session/i)).toBeInTheDocument();
    expect(screen.queryByText(/stored locally/i)).not.toBeInTheDocument();
  });

  it('does not render cloud storage warning and uses local wording when authRequired is false', () => {
    const mockProjects: ProjectSummary[] = [
      {
        id: 'proj-123',
        title: 'Local Project',
        original_filename: 'audio.mp3',
        media_type: 'audio',
        duration_seconds: 60,
        whisper_model: 'base',
        status: 'ready',
        segments_count: 5,
        created_at: '2026-10-27T10:00:00Z',
        updated_at: '2026-10-27T10:05:00Z',
      },
    ];

    render(
      <ProjectList
        projects={mockProjects}
        isLoading={false}
        onSelectProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
        authRequired={false}
      />
    );

    // Warning must NOT be visible
    expect(screen.queryByText(/Cloud Demo:/i)).not.toBeInTheDocument();

    // Subtitle indicates stored locally
    expect(screen.getByText(/1 project stored locally/i)).toBeInTheDocument();
    expect(screen.queryByText(/temporary cloud session/i)).not.toBeInTheDocument();
  });

  it('renders persistent cloud warning on empty state when authRequired is true', () => {
    render(
      <ProjectList
        projects={[]}
        isLoading={false}
        onSelectProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
        authRequired={true}
      />
    );

    expect(screen.getByText(/Cloud Demo:/i)).toBeInTheDocument();
    expect(screen.getByText('No Media Imported')).toBeInTheDocument();
  });

  it('renders cloud-specific loading description when authRequired is true', () => {
    render(
      <ProjectList
        projects={[]}
        isLoading={true}
        onSelectProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onRetryProcess={vi.fn()}
        onOpenImport={vi.fn()}
        authRequired={true}
      />
    );

    expect(screen.getByText(/Retrieving projects from cloud database/i)).toBeInTheDocument();
  });
});
