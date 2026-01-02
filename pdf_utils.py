import io
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfbase import pdfmetrics
from reportlab.platypus import (
    SimpleDocTemplate,
    Table,
    TableStyle,
    Paragraph,
    Spacer,
    CondPageBreak,
)


def _cell_text(value):
    if value is None:
        return ""
    return str(value)


def _calc_col_widths(headers, rows, font_name, font_size, padding=6):
    widths = []
    for col_idx in range(len(headers)):
        entries = [headers[col_idx]]
        for row in rows:
            if col_idx < len(row):
                entries.append(row[col_idx])
        max_width = max(
            pdfmetrics.stringWidth(_cell_text(val), font_name, font_size)
            for val in entries
        )
        widths.append(max_width + padding)
    return widths


def _split_columns(widths, available_width):
    if not widths:
        return []
    if sum(widths) <= available_width:
        return [list(range(len(widths)))]

    chunks = []
    start_idx = 1
    while start_idx < len(widths):
        current_width = widths[0]
        end_idx = start_idx
        while end_idx < len(widths) and current_width + widths[end_idx] <= available_width:
            current_width += widths[end_idx]
            end_idx += 1

        if end_idx == start_idx:
            end_idx = start_idx + 1

        chunks.append([0] + list(range(start_idx, end_idx)))
        start_idx = end_idx

    return chunks


def build_timetable_pdf(tables):
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )
    styles = getSampleStyleSheet()
    title_style = styles["Heading3"]
    title_style.spaceAfter = 6

    elements = []
    font_name = "Helvetica"
    font_size = 8

    for table in tables:
        title = _cell_text(table.get("title", "")).strip()
        headers = table.get("headers", [])
        rows = table.get("rows", [])

        if not headers or not rows:
            continue

        col_widths = _calc_col_widths(headers, rows, font_name, font_size)
        chunk_indices = _split_columns(col_widths, doc.width)

        for chunk in chunk_indices:
            chunk_headers = [headers[i] for i in chunk]
            chunk_rows = [[row[i] if i < len(row) else "" for i in chunk] for row in rows]
            data = [chunk_headers] + chunk_rows
            chunk_widths = [col_widths[i] for i in chunk]

            if title:
                title_para = Paragraph(title, title_style)
                title_height = title_para.wrap(doc.width, doc.height)[1]
            else:
                title_para = None
                title_height = 0

            pdf_table = Table(
                data,
                colWidths=chunk_widths,
                repeatRows=1,
                hAlign="RIGHT",
            )
            pdf_table.setStyle(
                TableStyle(
                    [
                        ("FONT", (0, 0), (-1, -1), font_name, font_size),
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
                        ("ALIGN", (0, 0), (0, -1), "RIGHT"),
                    ]
                )
            )
            table_height = pdf_table.wrap(doc.width, doc.height)[1]
            spacer_height = 14
            elements.append(
                CondPageBreak(title_height + table_height + spacer_height)
            )
            if title_para:
                elements.append(title_para)
            elements.append(pdf_table)
            elements.append(Spacer(1, spacer_height))

    if not elements:
        elements.append(Paragraph("No timetable data provided.", styles["Normal"]))

    doc.build(elements)
    return buffer.getvalue()
