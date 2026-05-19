export class AppError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AppError';
  }
}

export function handleError(error: unknown): never {
  if (error instanceof AppError) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  console.error('An unexpected error occurred');
  process.exit(1);
}
