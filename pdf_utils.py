import copy
import io
import os
import re
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
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
    if isinstance(value, dict):
        text = str(value.get("text", ""))
        platform_text = value.get("platformText")
        if platform_text:
            platform_text = str(platform_text)
            if text:
                return f"{text} {platform_text}"
            return platform_text
        return text
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
    drawing.width *= scale
    drawing.height *= scale
    return drawing


def _build_facilities_cell(value, icon_map, size, gap=2):
    if not isinstance(value, str):
        return value
    tokens = [t for t in value.split() if t]
    if not tokens:
        return ""
    icons = []
    for token in tokens:
        token_key = token.upper()
        if token_key in icon_map:
            icons.append(icon_map.get(token_key))
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


def _strip_markup(text):
    return re.sub(r"<[^>]+>", "", text or "")


def _format_cell_text(cell):
    if not isinstance(cell, dict):
        text = _cell_text(cell)
        return text
    base_text = str(cell.get("text", ""))
    platform_text = cell.get("platformText")
    formatted_time = base_text
    if formatted_time:
        if cell.get("bold"):
            formatted_time = f"<b>{formatted_time}</b>"
        if cell.get("italic"):
            formatted_time = f"<i>{formatted_time}</i>"
        if cell.get("strike"):
            formatted_time = f"<strike>{formatted_time}</strike>"
        color = cell.get("color")
        if color and color != "muted":
            formatted_time = f"<font color=\"{color}\">{formatted_time}</font>"
    formatted_platform = ""
    if platform_text:
        formatted_platform = str(platform_text)
        if cell.get("platformConfirmed"):
            formatted_platform = f"<b>{formatted_platform}</b>"
        if cell.get("platformChanged"):
            formatted_platform = (
                f"<font color=\"#a33b32\">{formatted_platform}</font>"
            )
    if formatted_time and formatted_platform:
        return f"{formatted_time} {formatted_platform}"
    if formatted_time:
        return formatted_time
    if formatted_platform:
        return formatted_platform
    text = _cell_text(cell)
    if not text:
        return text
    return text


def _build_key_item(
    icon, label, style, icon_size, gap=10, pill_padding=3, line_color=None
):
    label_text = _strip_markup(label)
    label_width = pdfmetrics.stringWidth(
        label_text, style.fontName, style.fontSize
    )
    border_color = line_color or colors.HexColor("#c6b7a2")
    bg_color = colors.HexColor("#f7f3ea")
    if icon is None:
        content = Paragraph(label, style)
        content_width = label_width
    else:
        icon_copy = copy.deepcopy(icon)
        spacer = Spacer(gap, 1)
        content = Table(
            [[icon_copy, spacer, Paragraph(label, style)]],
            colWidths=[icon_size, gap, None],
            hAlign="LEFT",
        )
        content.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]
            )
        )
        content_width = icon_size + gap + label_width

    pill = Table([[content]], hAlign="CENTER")
    pill.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.4, border_color),
                ("BACKGROUND", (0, 0), (-1, -1), bg_color),
                ("LEFTPADDING", (0, 0), (-1, -1), pill_padding),
                ("RIGHTPADDING", (0, 0), (-1, -1), pill_padding),
                ("TOPPADDING", (0, 0), (-1, -1), pill_padding),
                ("BOTTOMPADDING", (0, 0), (-1, -1), pill_padding),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    width = content_width + (pill_padding * 2)
    return pill, width


def _build_key_table(items, available_width, style, icon_size, cols=3, gap=10):
    if not items:
        return None, 0

    items_per_row = max(1, cols)
    rows = []
    row = []
    for icon, label in items:
        flowable, _ = _build_key_item(icon, label, style, icon_size)
        row.append(flowable)
        if len(row) == items_per_row:
            rows.append(row)
            row = []
    if row:
        row += [""] * (items_per_row - len(row))
        rows.append(row)

    col_width = available_width / items_per_row
    pill_padding = 3
    row_height = max(icon_size, style.leading) + (pill_padding * 2) + 2
    row_heights = [row_height] * len(rows)
    key_table = Table(
        rows,
        colWidths=[col_width] * items_per_row,
        rowHeights=row_heights,
        hAlign="LEFT",
    )
    key_table.setStyle(
        TableStyle(
            [
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), gap),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return key_table, key_table.wrap(available_width, 0)[1]


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
    font_name = "Helvetica"
    font_size = 8
    key_style = ParagraphStyle(
        "Key",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=10,
    )
    key_label_style = ParagraphStyle(
        "KeyLabel",
        parent=key_style,
        fontName="Helvetica-Bold",
        spaceAfter=2,
    )
    cell_style = ParagraphStyle(
        "Cell",
        parent=styles["Normal"],
        fontName=font_name,
        fontSize=font_size,
        leading=font_size + 2,
        spaceBefore=0,
        spaceAfter=0,
        leftIndent=0,
        rightIndent=0,
        alignment=1,
    )

    elements = []
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

    assets_dir = os.path.join(os.path.dirname(__file__), "docs", "icons")
    icon_size = 10
    icon_map = {
        "FC": _load_svg_icon(os.path.join(assets_dir, "first-class.svg"), icon_size),
        "SL": _load_svg_icon(os.path.join(assets_dir, "bed.svg"), icon_size),
        "BUS": _load_svg_icon(os.path.join(assets_dir, "bus.svg"), icon_size),
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
            facilities_tokens = set()
            if rows:
                facilities_row = rows[0]
                for col_idx in chunk:
                    if col_idx == 0 or col_idx >= len(facilities_row):
                        continue
                    raw_cell = facilities_row[col_idx]
                    for token in _cell_text(raw_cell).split():
                        facilities_tokens.add(token.upper())

            format_flags = {
                "bold": False,
                "italic": False,
                "strike": False,
                "color": False,
                "no_report": False,
                "out_of_order": False,
                "dep_before_arrival": False,
                "platform_any": False,
                "platform_confirmed": False,
                "platform_changed": False,
            }
            for row in chunk_rows[1:]:
                label = _cell_text(row[0]).strip() if row else ""
                if label in {"Comes from", "Continues to"}:
                    continue
                for cell in row[1:]:
                    if not isinstance(cell, dict):
                        continue
                    if cell.get("bold"):
                        format_flags["bold"] = True
                    if cell.get("italic"):
                        format_flags["italic"] = True
                    if cell.get("strike"):
                        format_flags["strike"] = True
                    if cell.get("color") and cell.get("color") != "muted":
                        format_flags["color"] = True
                    if cell.get("noReport"):
                        format_flags["no_report"] = True
                    if cell.get("platformText"):
                        format_flags["platform_any"] = True
                    if cell.get("platformConfirmed"):
                        format_flags["platform_confirmed"] = True
                    if cell.get("platformChanged"):
                        format_flags["platform_changed"] = True
                    if cell.get("bgColor"):
                        bg_color = str(cell.get("bgColor")).lower()
                        if bg_color == "#fce3b0":
                            format_flags["out_of_order"] = True
                        elif bg_color == "#e6d9ff":
                            format_flags["dep_before_arrival"] = True

            key_items = []
            if "FC" in facilities_tokens:
                key_items.append((icon_map.get("FC"), "First class"))
            if "SL" in facilities_tokens:
                key_items.append((icon_map.get("SL"), "Sleeper"))
            if "BUS" in facilities_tokens:
                key_items.append((icon_map.get("BUS"), "Bus service"))
            if format_flags["bold"]:
                key_items.append((None, "<b>12:34</b> Actual time"))
            if format_flags["italic"]:
                key_items.append((None, "<i>12:34</i> Predicted time"))
            if format_flags["no_report"]:
                key_items.append((None, "<i>12:34?</i> No realtime report"))
            if format_flags["strike"]:
                key_items.append((None, "<strike>12:34</strike> Cancelled"))
            if format_flags["color"]:
                key_items.append((None, "<font color=\"#2c6fbe\">12:34</font> Early running"))
                key_items.append((None, "<font color=\"#e53935\">12:34</font> Late running"))
            if format_flags["out_of_order"]:
                key_items.append(
                    (
                        None,
                        "<font backColor=\"#fce3b0\">12:34</font> Incorrect order",
                    )
                )
            if format_flags["dep_before_arrival"]:
                key_items.append(
                    (
                        None,
                        "<font backColor=\"#e6d9ff\">12:34</font> Departs before previous arrival",
                    )
                )
            if format_flags["platform_any"]:
                key_items.append((None, "12:34 [1] Platform"))
            if format_flags["platform_confirmed"]:
                key_items.append(
                    (None, "12:34 <b>[1]</b> Confirmed platform")
                )
            if format_flags["platform_changed"]:
                key_items.append(
                    (
                        None,
                        "12:34 <font color=\"#a33b32\">[1]</font> Changed platform",
                    )
                )

            highlight_styles = []
            data_rows = []
            for row_idx, row in enumerate(chunk_rows):
                row_label = _cell_text(row[0]).strip() if row else ""
                is_crs_row = row_label in {"Comes from", "Continues to"}
                row_cells = []
                for col_idx, cell in enumerate(row):
                    if isinstance(cell, dict):
                        plain = _cell_text(cell)
                        if is_crs_row and col_idx > 0 and plain:
                            row_cells.append(
                                Paragraph(f"<i>{plain}</i>", cell_style)
                            )
                        else:
                            formatted = _format_cell_text(cell)
                            if formatted != plain:
                                row_cells.append(Paragraph(formatted, cell_style))
                            else:
                                row_cells.append(plain)
                        bg_color = cell.get("bgColor")
                        if bg_color:
                            highlight_styles.append(
                                (
                                    col_idx,
                                    row_idx + 1,
                                    colors.HexColor(bg_color),
                                )
                            )
                    else:
                        plain = _cell_text(cell)
                        if is_crs_row and col_idx > 0 and plain:
                            row_cells.append(
                                Paragraph(f"<i>{plain}</i>", cell_style)
                            )
                        else:
                            row_cells.append(
                                _build_facilities_cell(cell, icon_map, icon_size)
                            )
                data_rows.append(row_cells)

            data = [chunk_headers] + data_rows
            chunk_widths = [col_widths[i] for i in chunk]

            if title:
                title_para = Paragraph(title, title_style)
                title_height = title_para.wrap(doc.width, doc.height)[1]
            else:
                title_para = None
                title_height = 0

            key_label_para = None
            key_table = None
            key_height = 0
            if key_items:
                key_label_para = Paragraph("Key:", key_label_style)
                key_label_height = key_label_para.wrap(doc.width, doc.height)[1]
                key_table, key_table_height = _build_key_table(
                    key_items, doc.width, key_style, icon_size
                )
                key_height = key_label_height + key_table_height

            crs_codes = {}
            for row in chunk_rows[1:]:
                label = _cell_text(row[0]).strip()
                if label not in {"Comes from", "Continues to"}:
                    continue
                for cell in row[1:]:
                    if isinstance(cell, dict):
                        code = _cell_text(cell.get("text", "")).strip()
                        title = _cell_text(cell.get("title", "")).strip()
                    else:
                        code = _cell_text(cell).strip()
                        title = ""
                    if code:
                        if code not in crs_codes:
                            crs_codes[code] = title
            crs_para = None
            crs_label_para = None
            crs_height = 0
            if crs_codes:
                sorted_codes = sorted(crs_codes.items(), key=lambda item: item[0])
                crs_list = "&nbsp;&nbsp;\u2022&nbsp;&nbsp;".join(
                    [
                        f"{code}: {title}" if title else code
                        for code, title in sorted_codes
                    ]
                )
                crs_label_para = Paragraph("Station codes:", key_label_style)
                crs_label_height = crs_label_para.wrap(doc.width, doc.height)[1]
                crs_para = Paragraph(crs_list, key_style)
                crs_height = (
                    crs_label_height + crs_para.wrap(doc.width, doc.height)[1] + 4
                )

            pdf_table = Table(data, colWidths=chunk_widths, repeatRows=1, hAlign="LEFT")
            line_color = colors.grey
            line_width = 0.5
            row_shade = colors.Color(250 / 255, 246 / 255, 239 / 255)
            table_style = [
                ("FONT", (0, 0), (-1, -1), font_name, font_size),
                ("FONTNAME", (0, 0), (-1, 1), "Helvetica-Bold"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("BACKGROUND", (0, 1), (-1, 1), colors.lightgrey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("ALIGN", (0, 0), (0, -1), "RIGHT"),
                ("LINEBEFORE", (0, 0), (-1, -1), line_width, line_color),
                ("LINEAFTER", (0, 0), (-1, -1), line_width, line_color),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("RIGHTPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
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

            for col_idx, row_idx, color in highlight_styles:
                table_style.append(
                    ("BACKGROUND", (col_idx, row_idx), (col_idx, row_idx), color)
                )

            pdf_table.setStyle(TableStyle(table_style))
            table_height = pdf_table.wrap(doc.width, doc.height)[1]
            spacer_height = 14
            elements.append(
                CondPageBreak(
                    title_height + key_height + table_height + crs_height + spacer_height
                )
            )
            if title_para:
                elements.append(title_para)
            if key_label_para and key_table:
                elements.append(key_label_para)
                elements.append(key_table)
                elements.append(Spacer(1, 6))
            elements.append(pdf_table)
            if crs_label_para and crs_para:
                elements.append(Spacer(1, 4))
                elements.append(crs_label_para)
                elements.append(crs_para)
            elements.append(Spacer(1, spacer_height))

    if not elements:
        elements.append(Paragraph("No timetable data provided.", styles["Normal"]))

    doc.build(elements, onFirstPage=draw_footer, onLaterPages=draw_footer)
    return buffer.getvalue()
