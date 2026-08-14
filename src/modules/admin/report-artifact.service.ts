import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { S3Service } from '../../storage/s3.service';

@Injectable()
export class ReportArtifactService {
  constructor(private readonly s3: S3Service) {}

  async write(
    jobId: string,
    format: string,
    rows: Record<string, unknown>[],
    title: string,
  ): Promise<string> {
    const key = `admin-jobs/${jobId}/${randomUUID()}.${format}`;
    const { body, contentType } = await this.render(format, rows, title);
    await this.s3.putPrivateObject(key, body, contentType);
    return key;
  }

  download(key: string) {
    return this.s3.createViewUrl(key, 15 * 60);
  }

  private async render(
    format: string,
    rows: Record<string, unknown>[],
    title: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (format === 'csv') {
      const lines = [
        columns.map(csvCell).join(','),
        ...rows.map((row) =>
          columns.map((column) => csvCell(value(row[column]))).join(','),
        ),
      ];
      return {
        body: Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8'),
        contentType: 'text/csv; charset=utf-8',
      };
    }
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Report');
      sheet.columns = columns.map((column) => ({
        header: column,
        key: column,
        width: 22,
      }));
      rows.forEach((row) =>
        sheet.addRow(
          Object.fromEntries(
            columns.map((column) => [column, value(row[column])]),
          ),
        ),
      );
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      const output = await workbook.xlsx.writeBuffer();
      return {
        body: Buffer.from(output),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    return {
      body: await pdf(title, columns, rows),
      contentType: 'application/pdf',
    };
  }
}

const value = (input: unknown): string | number | boolean =>
  input instanceof Date
    ? input.toISOString()
    : input === null || input === undefined
      ? ''
      : typeof input === 'object'
        ? JSON.stringify(input)
        : (input as string | number | boolean);
const csvCell = (input: unknown): string =>
  `"${String(value(input)).replaceAll('"', '""')}"`;

function pdf(
  title: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(16).text(title).moveDown();
    for (const row of rows) {
      doc
        .fontSize(8)
        .text(
          columns
            .map((column) => `${column}: ${value(row[column])}`)
            .join(' | '),
        );
      doc.moveDown(0.4);
      if (doc.y > 760) doc.addPage();
    }
    if (!rows.length)
      doc.fontSize(10).text('No records matched the selected filters.');
    doc.end();
  });
}
