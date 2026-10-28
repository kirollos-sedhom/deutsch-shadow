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
});
