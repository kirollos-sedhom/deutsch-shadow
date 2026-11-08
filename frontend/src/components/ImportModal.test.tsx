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
    expect(screen.getByText(/Choose a file or drag here/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Whisper Model Tier/i)).toBeInTheDocument();
  });

  it('renders cloud processing description and locks model tier select when isCloudMode is true', () => {
    render(
      <ImportModal
        isOpen={true}
        models={[
          {
            name: 'tiny',
            size_mb: 75,
            description: 'Cloud model',
            is_downloaded: true,
            is_recommended: true,
          },
        ]}
        recommendedModel="tiny"
        isSubmitting={false}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        isCloudMode={true}
      />
    );

    expect(
      screen.getByText(/Inference runs on the cloud server using faster-whisper \(tiny\) with int8 CPU quantization\./i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inference runs locally using faster-whisper with int8 CPU quantization\./i)
    ).not.toBeInTheDocument();

    const select = screen.getByLabelText(/Whisper Model Tier/i);
    expect(select).toBeDisabled();
  });

  it('renders local processing description and allows model selection when isCloudMode is false', () => {
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
        isCloudMode={false}
      />
    );

    expect(
      screen.getByText(/Inference runs locally using faster-whisper with int8 CPU quantization\./i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Inference runs on the cloud server/i)
    ).not.toBeInTheDocument();

    const select = screen.getByLabelText(/Whisper Model Tier/i);
    expect(select).not.toBeDisabled();
  });
});
