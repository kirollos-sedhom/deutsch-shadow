import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportModal } from './ImportModal';

describe('ImportModal Component', () => {
  it('does not render when closed', () => {
    const { container } = render(
      <ImportModal
        isOpen={false}
        models={[]}
        recommendedModel="base"
        isSubmitting={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal content and displays model options', () => {
    render(
      <ImportModal
        isOpen={true}
        models={[
          {
            name: 'base',
            size_mb: 145,
            description: 'Balanced for German',
            is_downloaded: true,
            is_recommended: true,
          },
        ]}
        recommendedModel="base"
        isSubmitting={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.getByText('Import German Media')).toBeInTheDocument();
    expect(screen.getByText(/Click to choose a file or drag and drop here/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Whisper Transcription Model/i)).toBeInTheDocument();
  });
});
