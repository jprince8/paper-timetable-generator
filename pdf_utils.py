import copy
import io
import os
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
from reportlab.graphics.shapes import Drawing
from svglib.svglib import svg2rlg


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
        max_width = 0
        for val in entries:
            if hasattr(val, "width"):
                max_width = max(max_width, val.width)
            else:
                max_width = max(
                    max_width,
                    pdfmetrics.stringWidth(
                        _cell_text(val), font_name, font_size
                    ),
                )
        widths.append(max_width + padding)
    return widths


def _load_svg_icon(path, size):
    drawing = svg2rlg(path)
    if drawing is None:
        return None
    if not drawing.width or not drawing.height:
        return drawing
    scale = size / max(drawing.width, drawing.height)
    drawing.scale(scale, scale)
    return drawing


def _build_facilities_cell(value, icon_map, size, gap=2):
    if not isinstance(value, str):
        return value
    tokens = [t for t in value.split() if t]
    if not tokens:
        return ""
    icons = [icon_map.get(token) for token in tokens if token in icon_map]
    icons = [icon for icon in icons if icon is not None]
    if not icons:
        return value

    width = len(icons) * size + max(0, len(icons) - 1) * gap
    drawing = Drawing(width, size)
    x_offset = 0
    for icon in icons:
        icon_copy = copy.deepcopy(icon)
        icon_copy.translate(x_offset, 0)
        drawing.add(icon_copy)
        x_offset += size + gap
    return drawing


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


def build_timetable_pdf(tables, meta=None):
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
    doc_title_style = styles["Heading2"]
    doc_title_style.fontSize = doc_title_style.fontSize * 1.5
    doc_subtitle_style = styles["Normal"]
    title_style = styles["Heading3"]
    title_style.fontName = "Helvetica-Bold"
    title_style.spaceAfter = 6

    elements = []
    font_name = "Helvetica"
    font_size = 8
    meta = meta or {}

    def draw_footer(canvas, doc):
        canvas.saveState()
        footer_text = "Created by Paper Timetable Generator using RTT data"
        page_text = f"Page {doc.page}"
        y = doc.bottomMargin - 18
        canvas.setFont(font_name, 8)
        canvas.drawString(doc.leftMargin, y, footer_text)
        canvas.drawRightString(doc.pagesize[0] - doc.rightMargin, y, page_text)
        canvas.restoreState()

    doc_title = _cell_text(meta.get("title", "")).strip()
    doc_subtitle = _cell_text(meta.get("subtitle", "")).strip()
    if doc_title:
        elements.append(Paragraph(doc_title, doc_title_style))
    if doc_title and doc_subtitle:
        elements.append(Spacer(1, 8))
    if doc_subtitle:
        elements.append(Paragraph(doc_subtitle, doc_subtitle_style))
        elements.append(Spacer(1, 6))

    assets_dir = os.path.join(os.path.dirname(__file__), "static", "icons")
    icon_size = 10
    icon_map = {
        "FC": _load_svg_icon(os.path.join(assets_dir, "first-class.svg"), icon_size),
        "SL": _load_svg_icon(os.path.join(assets_dir, "bed.svg"), icon_size),
    }

    for table in tables:
        base_title = _cell_text(table.get("title", "")).strip()
        date_label = _cell_text(table.get("dateLabel", "")).strip()
        service_times = table.get("serviceTimes", [])
        headers = table.get("headers", [])
        rows = table.get("rows", [])

        if not headers or not rows:
            continue

        col_widths = _calc_col_widths(headers, rows, font_name, font_size)
        chunk_indices = _split_columns(col_widths, doc.width)

        for chunk in chunk_indices:
            chunk_times = [
                service_times[i - 1]
                for i in chunk
                if i > 0 and i - 1 < len(service_times)
            ]
            chunk_times = [t for t in chunk_times if t]
            time_range = ""
            if chunk_times:
                time_start = chunk_times[0]
                time_end = chunk_times[-1]
                time_range = (
                    f"{time_start} to {time_end}"
                    if time_start != time_end
                    else time_start
                )

            title_parts = [p for p in [base_title, date_label, time_range] if p]
            title = " \u2022 ".join(title_parts)
            chunk_headers = [headers[i] for i in chunk]
            chunk_rows = [[row[i] if i < len(row) else "" for i in chunk] for row in rows]
            data = [chunk_headers] + [
                [
                    _build_facilities_cell(cell, icon_map, icon_size)
                    for cell in row
                ]
                for row in chunk_rows
            ]
            chunk_widths = [col_widths[i] for i in chunk]

            if title:
                title_para = Paragraph(title, title_style)
                title_height = title_para.wrap(doc.width, doc.height)[1]
            else:
                title_para = None
                title_height = 0

            pdf_table = Table(data, colWidths=chunk_widths, repeatRows=1, hAlign="LEFT")
            line_color = colors.grey
            line_width = 0.5
            row_shade = colors.Color(250 / 255, 246 / 255, 239 / 255)
            table_style = [
                ("FONT", (0, 0), (-1, -1), font_name, font_size),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("BACKGROUND", (0, 1), (-1, 1), colors.lightgrey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("ALIGN", (0, 0), (0, -1), "RIGHT"),
                ("LINEBEFORE", (0, 0), (-1, -1), line_width, line_color),
                ("LINEAFTER", (0, 0), (-1, -1), line_width, line_color),
            ]

            if len(rows) >= 1:
                table_style.append(
                    ("LINEBELOW", (0, 1), (-1, 1), line_width, line_color)
                )

            for row_idx, row in enumerate(rows):
                label = _cell_text(row[0]).strip() if row else ""
                data_row_idx = row_idx + 1
                if row_idx >= 1 and (row_idx - 1) % 2 == 1:
                    table_style.append(
                        ("BACKGROUND", (0, data_row_idx), (-1, data_row_idx), row_shade)
                    )
                if label == "Comes from":
                    table_style.append(
                        (
                            "LINEBELOW",
                            (0, data_row_idx),
                            (-1, data_row_idx),
                            line_width,
                            line_color,
                        )
                    )
                if label == "Continues to":
                    table_style.append(
                        (
                            "LINEABOVE",
                            (0, data_row_idx),
                            (-1, data_row_idx),
                            line_width,
                            line_color,
                        )
                    )
                if label.endswith("(dep)"):
                    table_style.append(
                        (
                            "LINEABOVE",
                            (0, data_row_idx),
                            (-1, data_row_idx),
                            line_width,
                            line_color,
                        )
                    )

            pdf_table.setStyle(TableStyle(table_style))
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

    doc.build(elements, onFirstPage=draw_footer, onLaterPages=draw_footer)
    return buffer.getvalue()
