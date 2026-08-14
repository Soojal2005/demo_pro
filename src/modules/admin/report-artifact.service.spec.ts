import { ReportArtifactService } from './report-artifact.service';

describe('ReportArtifactService', () => {
  it.each([
    ['csv', 'text/csv'],
    [
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['pdf', 'application/pdf'],
  ])(
    'generates a non-empty %s artifact in private storage',
    async (format, contentType) => {
      const s3 = { putPrivateObject: jest.fn(), createViewUrl: jest.fn() };
      const service = new ReportArtifactService(s3 as never);
      const key = await service.write(
        'job-1',
        format,
        [{ bookingNumber: 'HMG-1', amount: '599.00' }],
        'Test report',
      );
      expect(key).toMatch(new RegExp(`^admin-jobs/job-1/.+\\.${format}$`));
      expect(s3.putPrivateObject).toHaveBeenCalledWith(
        key,
        expect.any(Buffer),
        expect.stringContaining(contentType),
      );
      expect(
        (s3.putPrivateObject.mock.calls[0][1] as Buffer).length,
      ).toBeGreaterThan(20);
    },
  );
});
