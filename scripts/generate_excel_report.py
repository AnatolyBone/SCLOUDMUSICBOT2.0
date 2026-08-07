import json
import os
import sys
from datetime import datetime, timedelta, timezone

import xlsxwriter


MSK = timezone(timedelta(hours=3))
SHEET_DASHBOARD = 'Dashboard'
SHEET_EXECUTIVE = 'Executive Summary'
SHEET_USAGE = 'Использование'
SHEET_FUNNEL = 'Воронка продаж'
SHEET_TARIFFS = 'Тарифы'
SHEET_PAYMENTS = 'Платежи'
SHEET_CAMPAIGNS = 'Рассылки'
SHEET_LANGUAGES = 'Языки'
SHEET_DAILY = 'Дневная статистика'
SHEET_PAYMENT_LOSS = 'Потери в оплате'


def number(value, default=0):
    """Normalize PostgreSQL bigint/numeric JSON strings and NULL for XlsxWriter."""
    if value is None or value == '':
        return default
    try:
        parsed = float(value)
        return int(parsed) if parsed.is_integer() else parsed
    except (TypeError, ValueError):
        return default


def display_date(value):
    try:
        return datetime.strptime(str(value), '%Y-%m-%d').strftime('%d.%m.%Y')
    except (TypeError, ValueError):
        return str(value or '')


def percentage_change(current, previous):
    current = number(current)
    previous = number(previous)
    if previous == 0:
        return 0 if current == 0 else 1
    return (current - previous) / abs(previous)


def previous_day_percent_delta(current, previous):
    """Day-over-day percentage; unavailable for missing values or a zero baseline."""
    if current is None or previous is None:
        return None
    current_value = number(current)
    previous_value = number(previous)
    if previous_value == 0:
        return None
    return current_value / previous_value - 1


def half_period_trend(rows, key):
    values = [number(row.get(key)) for row in rows if row.get(key) is not None]
    if len(values) < 4:
        return None
    split = len(values) // 2
    previous_values = values[:split]
    current_values = values[-split:]
    previous = sum(previous_values) / len(previous_values)
    current = sum(current_values) / len(current_values)
    if previous == 0 and current != 0:
        return None
    return percentage_change(current, previous)


def trend_status(change):
    if change is None:
        return 'Недостаточно данных', 'neutral'
    if change > 0.005:
        return '🟢 Рост', 'positive'
    if change < -0.005:
        return '🔴 Падение', 'negative'
    return '🟡 Без изменений', 'neutral'


def safe_autofit(worksheet, max_width=260):
    try:
        worksheet.autofit(max_width)
    except AttributeError:
        # XlsxWriter < 3.0 has no autofit; explicit widths still keep the report usable.
        pass


def configure_sheet(worksheet, tab_color='#1F4E78'):
    worksheet.hide_gridlines(2)
    worksheet.set_tab_color(tab_color)
    worksheet.set_landscape()
    worksheet.fit_to_pages(1, 0)
    worksheet.set_margins(0.3, 0.3, 0.5, 0.5)


def write_back_link(worksheet, link_format):
    worksheet.write_url('A1', f"internal:'{SHEET_DASHBOARD}'!B2", link_format, '← Dashboard')


def add_change_formatting(worksheet, cell_range, positive_format, negative_format, neutral_format):
    worksheet.conditional_format(cell_range, {
        'type': 'cell', 'criteria': '>', 'value': 0, 'format': positive_format
    })
    worksheet.conditional_format(cell_range, {
        'type': 'cell', 'criteria': '<', 'value': 0, 'format': negative_format
    })
    worksheet.conditional_format(cell_range, {
        'type': 'cell', 'criteria': '==', 'value': 0, 'format': neutral_format
    })


def main():
    if len(sys.argv) < 3:
        print('Usage: python generate_excel_report.py <input_json_path> <output_xlsx_path>')
        sys.exit(1)

    json_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(json_path, 'r', encoding='utf-8') as source:
        data = json.load(source)

    summary = data.get('summary', {})
    daily_stats = data.get('daily_stats', [])
    funnel_data = data.get('funnel', [])
    usage_data = data.get('usage', [])
    tariff_rows = data.get('tariffs', [])
    payments = data.get('payments', [])
    campaigns = data.get('campaigns', [])
    language_rows = data.get('languages', [])
    payment_loss = data.get('payment_loss', {})
    report_note = data.get('report_note')

    period = data.get('period', {})
    start_date = display_date(data.get('startDate'))
    end_date = display_date(data.get('endDate'))
    requested_end_date = display_date(data.get('requestedEndDate'))
    period_note = f'Фактические данные: {start_date} — {end_date}'
    if period.get('isTruncated'):
        period_note += f' · запрошено по {requested_end_date}'
    generated_at = datetime.now(MSK).strftime('%d.%m.%Y %H:%M MSK')

    workbook = xlsxwriter.Workbook(output_path)
    workbook.set_properties({
        'title': f'SCM Analytics Report — {start_date} — {end_date}',
        'subject': 'SCloudMusicBot analytics',
        'author': 'SCloudMusicBot',
        'company': 'SCM',
        'comments': f'Generated {generated_at}'
    })

    # Brand and table styles.
    title_format = workbook.add_format({
        'bold': True, 'font_size': 22, 'font_name': 'Segoe UI', 'font_color': '#17365D'
    })
    section_title_format = workbook.add_format({
        'bold': True, 'font_size': 16, 'font_name': 'Segoe UI', 'font_color': '#1F4E78'
    })
    subtitle_format = workbook.add_format({
        'font_size': 10, 'font_name': 'Segoe UI', 'font_color': '#667085'
    })
    header_format = workbook.add_format({
        'bold': True, 'font_name': 'Segoe UI', 'font_color': '#FFFFFF',
        'bg_color': '#1F4E78', 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'border_color': '#D0D5DD', 'text_wrap': True
    })
    cell_left = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'left', 'valign': 'vcenter',
        'border': 1, 'border_color': '#E4E7EC'
    })
    cell_center = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'border_color': '#E4E7EC'
    })
    integer_format = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '#,##0',
        'border': 1, 'border_color': '#E4E7EC'
    })
    currency_format = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '#,##0.00 "₽"',
        'border': 1, 'border_color': '#E4E7EC'
    })
    stars_format = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '"★" #,##0',
        'border': 1, 'border_color': '#E4E7EC'
    })
    percent_format = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '0.00%',
        'border': 1, 'border_color': '#E4E7EC'
    })
    link_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#175CD3', 'underline': True, 'bold': True
    })
    nav_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#FFFFFF', 'bg_color': '#2E75B6',
        'bold': True, 'align': 'center', 'valign': 'vcenter', 'border': 1,
        'border_color': '#D0D5DD'
    })
    card_label_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#475467', 'bg_color': '#F2F4F7',
        'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#D0D5DD'
    })
    card_value_format = workbook.add_format({
        'bold': True, 'font_size': 15, 'font_name': 'Segoe UI', 'font_color': '#1F4E78',
        'bg_color': '#F9FAFB', 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'border_color': '#D0D5DD', 'num_format': '#,##0'
    })
    card_currency_format = workbook.add_format({
        'bold': True, 'font_size': 15, 'font_name': 'Segoe UI', 'font_color': '#027A48',
        'bg_color': '#F9FAFB', 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'border_color': '#D0D5DD', 'num_format': '#,##0.00 "₽"'
    })
    card_stars_format = workbook.add_format({
        'bold': True, 'font_size': 15, 'font_name': 'Segoe UI', 'font_color': '#B54708',
        'bg_color': '#F9FAFB', 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'border_color': '#D0D5DD', 'num_format': '"★" #,##0'
    })
    positive_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#027A48', 'bg_color': '#ECFDF3',
        'num_format': '+0.0%;-0.0%;0.0%', 'border': 1, 'border_color': '#A6F4C5'
    })
    negative_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#B42318', 'bg_color': '#FEF3F2',
        'num_format': '+0.0%;-0.0%;0.0%', 'border': 1, 'border_color': '#FECDCA'
    })
    neutral_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#B54708', 'bg_color': '#FFFAEB',
        'num_format': '+0.0%;-0.0%;0.0%', 'border': 1, 'border_color': '#FEDF89'
    })
    positive_text_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#027A48', 'bg_color': '#ECFDF3',
        'bold': True, 'align': 'center', 'border': 1, 'border_color': '#A6F4C5'
    })
    negative_text_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#B42318', 'bg_color': '#FEF3F2',
        'bold': True, 'align': 'center', 'border': 1, 'border_color': '#FECDCA'
    })
    neutral_text_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_color': '#B54708', 'bg_color': '#FFFAEB',
        'bold': True, 'align': 'center', 'border': 1, 'border_color': '#FEDF89'
    })
    summary_text_format = workbook.add_format({
        'font_name': 'Segoe UI', 'font_size': 11, 'font_color': '#344054',
        'bg_color': '#F9FAFB', 'border': 1, 'border_color': '#EAECF0',
        'text_wrap': True, 'valign': 'vcenter'
    })

    status_formats = {
        'positive': positive_text_format,
        'negative': negative_text_format,
        'neutral': neutral_text_format
    }

    dau_trend = half_period_trend(daily_stats, 'dau')
    rub_trend = half_period_trend(daily_stats, 'revenue_rub')
    stars_trend = half_period_trend(daily_stats, 'revenue_stars')
    registration_trend = half_period_trend(daily_stats, 'registrations')
    download_trend = half_period_trend(daily_stats, 'downloads')

    first_funnel_count = number(funnel_data[0].get('count')) if funnel_data else 0
    paid_funnel_count = number(funnel_data[-1].get('count')) if funnel_data else 0
    payment_conversion = paid_funnel_count / first_funnel_count if first_funnel_count else 0
    dau_trend_text = f'{dau_trend:+.1%}' if dau_trend is not None else 'Недостаточно данных для сравнения'
    activity_days = number(period.get('activityDaysAvailable'))
    mau_note = (f'MAU рассчитан по {activity_days} дням доступной истории. '
                + ('Полное 30-дневное окно накоплено.' if period.get('mauWindowComplete') else 'Полное 30-дневное окно ещё не накоплено.'))

    tariff_totals = {
        'Plus': sum(number(row.get('plus')) for row in tariff_rows),
        'Pro': sum(number(row.get('pro')) for row in tariff_rows),
        'Unlimited': sum(number(row.get('unlim')) for row in tariff_rows)
    }
    popular_tariff = max(tariff_totals, key=tariff_totals.get) if any(tariff_totals.values()) else 'нет данных'

    currency_counts = {}
    for row in payments:
        currency = row.get('currency') or 'UNKNOWN'
        currency_counts[currency] = currency_counts.get(currency, 0) + number(row.get('count'))
    primary_currency = max(currency_counts, key=currency_counts.get) if currency_counts else 'нет данных'
    primary_source = 'Telegram Stars' if primary_currency == 'XTR' else primary_currency

    best_campaign = None
    best_ctr = 0
    for campaign in campaigns:
        delivered = number(campaign.get('delivered'))
        ctr = number(campaign.get('clicks')) / delivered if delivered else 0
        if best_campaign is None or ctr > best_ctr:
            best_campaign = campaign
            best_ctr = ctr

    # ================================================================
    # SHEET 1: Executive Summary
    # ================================================================
    executive = workbook.add_worksheet(SHEET_EXECUTIVE)
    configure_sheet(executive, '#17365D')
    executive.activate()
    executive.set_zoom(95)
    executive.set_column('A:A', 3)
    executive.set_column('B:B', 4)
    executive.set_column('C:I', 18)
    executive.set_row(1, 32)
    executive.write('B2', 'SCM Executive Summary', title_format)
    executive.write('B3', period_note, section_title_format)
    executive.write('B4', f'Generated: {generated_at}', subtitle_format)
    if report_note:
        executive.write('B5', report_note, subtitle_format)
    executive.insert_textbox('H2', '♫\nSCM', {
        'width': 110, 'height': 70, 'font': {'name': 'Segoe UI', 'size': 18, 'bold': True, 'color': '#FFFFFF'},
        'align': {'vertical': 'middle', 'horizontal': 'center'},
        'fill': {'color': '#1F4E78'}, 'line': {'color': '#1F4E78'},
        'gradient': {'colors': ['#17365D', '#2E75B6'], 'angle': 45}
    })

    summary_lines = [
        f'За выбранный период зарегистрировано {number(summary.get("new_users")):,} новых пользователей.',
        f'Средний DAU составил {number(summary.get("avg_dau")):,}; динамика второй половины периода: {dau_trend_text}.',
        f'Пользователи выполнили {number(summary.get("total_downloads")):,} скачиваний.',
        f'Конверсия от входа в воронку до оплаты: {payment_conversion:.2%} ({paid_funnel_count:,} оплативших).',
        f'Самый популярный тариф по количеству оплат — {popular_tariff}.',
        f'Основная платёжная валюта по количеству операций — {primary_source}.',
        f'Выручка: {number(summary.get("revenue_rub")):,.2f} ₽ и {number(summary.get("revenue_stars")):,} Stars.'
    ]
    summary_lines.insert(2, mau_note)
    if best_campaign:
        summary_lines.append(
            f'Лучший CTR рассылки: {best_ctr:.2%} — {best_campaign.get("name") or "Без названия"}.'
        )

    executive.write('B6', 'Ключевые выводы', section_title_format)
    for index, line in enumerate(summary_lines, start=7):
        executive.write_number(index - 1, 1, index - 6, integer_format)
        executive.merge_range(index - 1, 2, index - 1, 8, line, summary_text_format)
        executive.set_row(index - 1, 28)

    executive.write('B18', 'Навигация по отчёту', section_title_format)
    navigation = [
        ('📈 Dashboard', SHEET_DASHBOARD), ('→ Использование', SHEET_USAGE), ('→ Воронка', SHEET_FUNNEL),
        ('→ Платежи', SHEET_PAYMENTS), ('→ Рассылки', SHEET_CAMPAIGNS),
        ('→ Языки', SHEET_LANGUAGES), ('→ Дневная статистика', SHEET_DAILY),
        ('→ Потери в оплате', SHEET_PAYMENT_LOSS)
    ]
    for index, (label, sheet_name) in enumerate(navigation):
        row = 19 + index // 3
        column = 1 + (index % 3) * 2
        executive.merge_range(row, column, row, column + 1, '', nav_format)
        executive.write_url(row, column, f"internal:'{sheet_name}'!A1", nav_format, label)

    # ================================================================
    # SHEET 2: Dashboard
    # ================================================================
    dashboard = workbook.add_worksheet(SHEET_DASHBOARD)
    configure_sheet(dashboard, '#2E75B6')
    dashboard.set_zoom(85)
    dashboard.set_column('A:A', 3)
    dashboard.set_column('B:D', 21)
    dashboard.set_column('E:E', 18)
    dashboard.set_column('F:H', 18)
    dashboard.set_row(1, 32)
    dashboard.write('B2', 'SCM Analytics Report', title_format)
    dashboard.write('B3', period_note, section_title_format)
    dashboard.write('B4', f'Generated: {generated_at}', subtitle_format)
    if report_note:
        dashboard.write('B5', report_note, subtitle_format)
    dashboard.insert_textbox('H2', '♫\nSCM', {
        'width': 90, 'height': 65, 'font': {'name': 'Segoe UI', 'size': 16, 'bold': True, 'color': '#FFFFFF'},
        'align': {'vertical': 'middle', 'horizontal': 'center'},
        'fill': {'color': '#1F4E78'}, 'line': {'color': '#1F4E78'}
    })

    dashboard_nav = [
        ('Executive Summary', SHEET_EXECUTIVE), ('Использование', SHEET_USAGE), ('Воронка', SHEET_FUNNEL),
        ('Платежи', SHEET_PAYMENTS), ('Рассылки', SHEET_CAMPAIGNS),
        ('Языки', SHEET_LANGUAGES), ('Дневная статистика', SHEET_DAILY),
        ('Потери в оплате', SHEET_PAYMENT_LOSS)
    ]
    for index, (label, sheet_name) in enumerate(dashboard_nav):
        dashboard.write_url(5 + index // 4, 1 + index % 4, f"internal:'{sheet_name}'!A1", nav_format, label)

    cards = [
        ('Всего пользователей', summary.get('total_users'), card_value_format),
        ('Новых за период', summary.get('new_users'), card_value_format),
        ('Средний DAU', summary.get('avg_dau'), card_value_format),
        ('Средний WAU', summary.get('avg_wau'), card_value_format),
        ('Средний MAU', summary.get('avg_mau'), card_value_format),
        ('Всего скачиваний', summary.get('total_downloads'), card_value_format),
        ('Выручка RUB', summary.get('revenue_rub'), card_currency_format),
        ('Выручка Stars', summary.get('revenue_stars'), card_stars_format),
        ('Количество оплат', summary.get('payments_count'), card_value_format)
    ]
    for index, (label, raw_value, value_format) in enumerate(cards):
        column = 1 + index % 3
        row = 7 + (index // 3) * 3
        dashboard.write(row, column, label, card_label_format)
        dashboard.write_number(row + 1, column, number(raw_value), value_format)
        dashboard.set_row(row, 20)
        dashboard.set_row(row + 1, 28)

    dashboard.write_row('F8', ['Метрика', 'Изменение', 'Статус'], header_format)
    trend_rows = [
        ('DAU', dau_trend), ('Выручка RUB', rub_trend), ('Выручка Stars', stars_trend),
        ('Регистрации', registration_trend), ('Скачивания', download_trend)
    ]
    for index, (metric, change) in enumerate(trend_rows, start=9):
        status, status_key = trend_status(change)
        dashboard.write(f'F{index}', metric, cell_left)
        if change is None:
            dashboard.write(f'G{index}', 'н/д', cell_center)
        else:
            dashboard.write_number(f'G{index}', change, percent_format)
        dashboard.write(f'H{index}', status, status_formats[status_key])
    add_change_formatting(dashboard, f'G9:G{8 + len(trend_rows)}', positive_format, negative_format, neutral_format)

    num_daily_rows = len(daily_stats)
    if num_daily_rows:
        activity_chart = workbook.add_chart({'type': 'line'})
        activity_chart.set_title({'name': 'Активность пользователей (DAU / WAU / MAU)'})
        activity_chart.set_style(10)
        activity_chart.set_size({'width': 760, 'height': 310})
        for column, color, name in [('B', '#4E73DF', 'DAU'), ('D', '#36B9CC', 'WAU'), ('E', '#1CC88A', 'MAU')]:
            activity_chart.add_series({
                'name': name,
                'categories': f"='{SHEET_DAILY}'!$A$2:$A${num_daily_rows + 1}",
                'values': f"='{SHEET_DAILY}'!${column}$2:${column}${num_daily_rows + 1}",
                'line': {'color': color, 'width': 2}
            })
        activity_chart.set_legend({'position': 'bottom'})
        dashboard.insert_chart('B18', activity_chart)

        downloads_chart = workbook.add_chart({'type': 'area'})
        downloads_chart.set_title({'name': 'Динамика скачиваний'})
        downloads_chart.set_style(10)
        downloads_chart.set_size({'width': 375, 'height': 245})
        downloads_chart.add_series({
            'name': 'Скачивания',
            'categories': f"='{SHEET_DAILY}'!$A$2:$A${num_daily_rows + 1}",
            'values': f"='{SHEET_DAILY}'!$G$2:$G${num_daily_rows + 1}",
            'fill': {'color': '#4E73DF', 'transparency': 65},
            'line': {'color': '#4E73DF'}
        })
        dashboard.insert_chart('B35', downloads_chart)

        revenue_chart = workbook.add_chart({'type': 'column'})
        revenue_chart.set_title({'name': 'Ежедневная выручка'})
        revenue_chart.set_style(10)
        revenue_chart.set_size({'width': 375, 'height': 245})
        revenue_chart.add_series({
            'name': 'RUB',
            'categories': f"='{SHEET_DAILY}'!$A$2:$A${num_daily_rows + 1}",
            'values': f"='{SHEET_DAILY}'!$I$2:$I${num_daily_rows + 1}",
            'fill': {'color': '#1CC88A'}
        })
        revenue_chart.add_series({
            'name': 'Stars',
            'categories': f"='{SHEET_DAILY}'!$A$2:$A${num_daily_rows + 1}",
            'values': f"='{SHEET_DAILY}'!$K$2:$K${num_daily_rows + 1}",
            'fill': {'color': '#F6C23E'}
        })
        dashboard.insert_chart('F35', revenue_chart)

    # ================================================================
    # SHEET 3: Usage (independent user behaviors, not a sequential funnel)
    # ================================================================
    usage = workbook.add_worksheet(SHEET_USAGE)
    configure_sheet(usage, '#36B9CC')
    write_back_link(usage, link_format)
    usage.write('B2', 'Использование бота', section_title_format)
    usage.write('B3', f'Независимые аудитории · {period_note}', subtitle_format)
    usage.write_row('B5', ['Метрика', 'Уникальные пользователи'], header_format)
    usage_labels = {
        'Active users': 'Активные пользователи',
        'Search users': 'Отправили поисковый запрос',
        'Direct-link users': 'Отправили прямую ссылку',
        'Successful download users': 'Скачали хотя бы один трек'
    }
    for index, row_data in enumerate(usage_data, start=6):
        usage.write(f'B{index}', usage_labels.get(row_data.get('metric'), row_data.get('metric') or '—'), cell_left)
        raw_count = row_data.get('count')
        if raw_count is None:
            usage.write(f'C{index}', 'н/д', cell_center)
        else:
            usage.write_number(f'C{index}', number(raw_count), integer_format)
    if usage_data:
        usage.autofilter(f'B5:C{len(usage_data) + 5}')
    usage.freeze_panes(5, 1)
    safe_autofit(usage)
    usage.set_column('B:B', 38)
    usage.set_column('C:C', 24)

    # ================================================================
    # SHEET 4: Funnel
    # ================================================================
    funnel = workbook.add_worksheet(SHEET_FUNNEL)
    configure_sheet(funnel, '#4E73DF')
    write_back_link(funnel, link_format)
    funnel.write('B2', 'Воронка продаж тарифов', section_title_format)
    funnel.write('B3', f'Конверсия по ключевым этапам · {start_date} — {end_date}', subtitle_format)
    funnel.write_row('B5', ['Этап', 'Количество', 'От входа', 'От предыдущего этапа'], header_format)
    total_entered = first_funnel_count if first_funnel_count else 1
    previous_count = total_entered
    for index, row_data in enumerate(funnel_data, start=6):
        current_count = number(row_data.get('count'))
        funnel.write(f'B{index}', row_data.get('stage') or '—', cell_left)
        funnel.write_number(f'C{index}', current_count, integer_format)
        funnel.write_number(f'D{index}', current_count / total_entered, percent_format)
        funnel.write_number(f'E{index}', current_count / previous_count if previous_count else 0, percent_format)
        previous_count = current_count
    if funnel_data:
        funnel.autofilter(f'B5:E{len(funnel_data) + 5}')
        funnel.conditional_format(f'D6:E{len(funnel_data) + 5}', {'type': 'data_bar', 'bar_color': '#4E73DF'})
    funnel.freeze_panes(5, 1)
    funnel_chart = workbook.add_chart({'type': 'bar'})
    funnel_chart.set_title({'name': 'Количество пользователей по этапам'})
    funnel_chart.set_style(10)
    funnel_chart.set_size({'width': 620, 'height': 320})
    if funnel_data:
        funnel_chart.add_series({
            'name': 'Пользователи',
            'categories': f"='{SHEET_FUNNEL}'!$B$6:$B${len(funnel_data) + 5}",
            'values': f"='{SHEET_FUNNEL}'!$C$6:$C${len(funnel_data) + 5}",
            'fill': {'color': '#4E73DF'}
        })
        funnel.insert_chart('G5', funnel_chart)
    safe_autofit(funnel)
    funnel.set_column('B:B', 28)

    # ================================================================
    # SHEET 4: Tariffs
    # ================================================================
    tariffs = workbook.add_worksheet(SHEET_TARIFFS)
    configure_sheet(tariffs, '#1CC88A')
    write_back_link(tariffs, link_format)
    tariffs.write('B2', 'Популярность тарифных планов', section_title_format)
    tariffs.write('B3', f'Завершённые оплаты по дням · {start_date} — {end_date}', subtitle_format)
    tariffs.write_row('B5', ['Дата', 'Plus', 'Pro', 'Unlimited'], header_format)
    for index, row_data in enumerate(tariff_rows, start=6):
        tariffs.write(f'B{index}', display_date(row_data.get('day')), cell_center)
        tariffs.write_number(f'C{index}', number(row_data.get('plus')), integer_format)
        tariffs.write_number(f'D{index}', number(row_data.get('pro')), integer_format)
        tariffs.write_number(f'E{index}', number(row_data.get('unlim')), integer_format)
    if tariff_rows:
        tariffs.autofilter(f'B5:E{len(tariff_rows) + 5}')
    tariffs.freeze_panes(5, 1)
    tariff_chart = workbook.add_chart({'type': 'line'})
    tariff_chart.set_title({'name': 'Популярность тарифов по дням'})
    tariff_chart.set_style(10)
    tariff_chart.set_size({'width': 650, 'height': 300})
    if tariff_rows:
        for column, name, color in [('C', 'Plus', '#4E73DF'), ('D', 'Pro', '#1CC88A'), ('E', 'Unlimited', '#F6C23E')]:
            tariff_chart.add_series({
                'name': name,
                'categories': f"='{SHEET_TARIFFS}'!$B$6:$B${len(tariff_rows) + 5}",
                'values': f"='{SHEET_TARIFFS}'!${column}$6:${column}${len(tariff_rows) + 5}",
                'line': {'color': color, 'width': 2}
            })
        tariffs.insert_chart('G5', tariff_chart)
    safe_autofit(tariffs)

    # ================================================================
    # SHEET 5: Payments
    # ================================================================
    payment_sheet = workbook.add_worksheet(SHEET_PAYMENTS)
    configure_sheet(payment_sheet, '#027A48')
    write_back_link(payment_sheet, link_format)
    payment_sheet.write('B2', 'История платежей', section_title_format)
    payment_sheet.write('B3', f'Успешные оплаты · {start_date} — {end_date}', subtitle_format)
    payment_sheet.write_row('B5', ['Дата', 'Метод', 'Валюта', 'Сумма', 'Тариф', 'Количество'], header_format)
    for index, row_data in enumerate(payments, start=6):
        payment_sheet.write(f'B{index}', display_date(row_data.get('date')), cell_center)
        payment_sheet.write(f'C{index}', row_data.get('method') or '—', cell_left)
        payment_sheet.write(f'D{index}', row_data.get('currency') or '—', cell_center)
        amount_format = currency_format if row_data.get('currency') == 'RUB' else stars_format
        payment_sheet.write_number(f'E{index}', number(row_data.get('amount')), amount_format)
        payment_sheet.write(f'F{index}', str(row_data.get('plan') or '—').upper(), cell_center)
        payment_sheet.write_number(f'G{index}', number(row_data.get('count')), integer_format)
    payment_last_row = max(6, len(payments) + 5)
    if payments:
        payment_sheet.autofilter(f'B5:G{payment_last_row}')
    payment_sheet.freeze_panes(5, 1)
    rub_total = sum(
        number(row.get('amount')) * number(row.get('count'), 1)
        for row in payments if row.get('currency') == 'RUB'
    )
    stars_total = sum(
        number(row.get('amount')) * number(row.get('count'), 1)
        for row in payments if row.get('currency') == 'XTR'
    )
    payment_sheet.write_row('I5', ['Валюта', 'Общая выручка'], header_format)
    payment_sheet.write('I6', 'Российский рубль (RUB)', cell_left)
    payment_sheet.write_formula('J6', f'=SUMPRODUCT((D6:D{payment_last_row}="RUB")*E6:E{payment_last_row}*G6:G{payment_last_row})', currency_format, rub_total)
    payment_sheet.write('I7', 'Telegram Stars (XTR)', cell_left)
    payment_sheet.write_formula('J7', f'=SUMPRODUCT((D6:D{payment_last_row}="XTR")*E6:E{payment_last_row}*G6:G{payment_last_row})', stars_format, stars_total)
    safe_autofit(payment_sheet)
    payment_sheet.set_column('C:C', 22)

    # ================================================================
    # SHEET 6: Campaigns
    # ================================================================
    campaign_sheet = workbook.add_worksheet(SHEET_CAMPAIGNS)
    configure_sheet(campaign_sheet, '#B54708')
    write_back_link(campaign_sheet, link_format)
    campaign_sheet.write('B2', 'Эффективность рассылок', section_title_format)
    campaign_sheet.write('B3', f'Доставки, клики и оплаты за 24 часа · {start_date} — {end_date}', subtitle_format)
    campaign_sheet.write_row('B5', [
        'ID', 'Кампания', 'UTM-тег', 'Дата', 'Получатели', 'Доставлено',
        'Клики', 'CTR', 'Оплаты 24ч', 'Конверсия 24ч'
    ], header_format)
    for index, row_data in enumerate(campaigns, start=6):
        campaign_sheet.write_number(f'B{index}', number(row_data.get('id')), integer_format)
        campaign_sheet.write(f'C{index}', row_data.get('name') or 'Без названия', cell_left)
        campaign_sheet.write(f'D{index}', row_data.get('tag') or '—', cell_center)
        campaign_sheet.write(f'E{index}', display_date(row_data.get('date')), cell_center)
        campaign_sheet.write_number(f'F{index}', number(row_data.get('recipients')), integer_format)
        campaign_sheet.write_number(f'G{index}', number(row_data.get('delivered')), integer_format)
        campaign_sheet.write_number(f'H{index}', number(row_data.get('clicks')), integer_format)
        campaign_sheet.write_formula(f'I{index}', f'=IF(G{index}>0,H{index}/G{index},0)', percent_format)
        campaign_sheet.write_number(f'J{index}', number(row_data.get('conversions_24h')), integer_format)
        campaign_sheet.write_formula(f'K{index}', f'=IF(G{index}>0,J{index}/G{index},0)', percent_format)
    campaign_last_row = max(6, len(campaigns) + 5)
    if campaigns:
        campaign_sheet.autofilter(f'B5:K{campaign_last_row}')
        campaign_sheet.conditional_format(f'I6:I{campaign_last_row}', {
            'type': '3_color_scale', 'min_color': '#FEE4E2', 'mid_color': '#FEF0C7', 'max_color': '#D1FADF'
        })
        campaign_sheet.conditional_format(f'J6:J{campaign_last_row}', {'type': 'data_bar', 'bar_color': '#2E75B6'})
        campaign_sheet.conditional_format(f'K6:K{campaign_last_row}', {
            'type': '3_color_scale', 'min_color': '#FEE4E2', 'mid_color': '#FEF0C7', 'max_color': '#D1FADF'
        })
    campaign_sheet.freeze_panes(5, 1)
    safe_autofit(campaign_sheet)
    campaign_sheet.set_column('C:C', 28)

    # ================================================================
    # SHEET 7: Languages
    # ================================================================
    languages = workbook.add_worksheet(SHEET_LANGUAGES)
    configure_sheet(languages, '#7F56D9')
    write_back_link(languages, link_format)
    languages.write('B2', 'Языковые сегменты пользователей', section_title_format)
    languages.write('B3', f'Размер, активность и оплаты · {start_date} — {end_date}', subtitle_format)
    languages.write_row('B5', ['Язык', 'Всего пользователей', 'Активных за период', 'Платящих пользователей'], header_format)
    for index, row_data in enumerate(language_rows, start=6):
        languages.write(f'B{index}', row_data.get('language') or 'UNKNOWN', cell_center)
        languages.write_number(f'C{index}', number(row_data.get('users')), integer_format)
        languages.write_number(f'D{index}', number(row_data.get('active')), integer_format)
        languages.write_number(f'E{index}', number(row_data.get('payments')), integer_format)
    if language_rows:
        languages.autofilter(f'B5:E{len(language_rows) + 5}')
    languages.freeze_panes(5, 1)
    language_chart = workbook.add_chart({'type': 'pie'})
    language_chart.set_title({'name': 'Распределение аудитории по языкам'})
    language_chart.set_style(10)
    language_chart.set_size({'width': 450, 'height': 260})
    if language_rows:
        language_chart.add_series({
            'name': 'Языки',
            'categories': f"='{SHEET_LANGUAGES}'!$B$6:$B${len(language_rows) + 5}",
            'values': f"='{SHEET_LANGUAGES}'!$C$6:$C${len(language_rows) + 5}",
            'data_labels': {'percentage': True, 'leader_lines': True}
        })
        languages.insert_chart('G5', language_chart)
    safe_autofit(languages)

    # ================================================================
    # SHEET 8: Daily statistics
    # ================================================================
    daily = workbook.add_worksheet(SHEET_DAILY)
    configure_sheet(daily, '#36B9CC')
    daily.write_url('N1', f"internal:'{SHEET_DASHBOARD}'!B2", link_format, '← Dashboard')
    daily.write_row('A1', [
        'Дата', 'DAU', 'Δ DAU', 'WAU', 'MAU', 'Регистрации', 'Скачивания', 'Лимиты',
        'Выручка RUB', 'Δ RUB', 'Выручка Stars', 'Δ Stars'
    ], header_format)
    daily.merge_range('M2:N3', mau_note, summary_text_format)
    for index, row_data in enumerate(daily_stats, start=2):
        daily.write(f'A{index}', display_date(row_data.get('day')), cell_center)
        activity_available = row_data.get('activity_available', row_data.get('dau') is not None)
        if activity_available:
            daily.write_number(f'B{index}', number(row_data.get('dau')), integer_format)
            daily.write_number(f'D{index}', number(row_data.get('wau')), integer_format)
            daily.write_number(f'E{index}', number(row_data.get('mau')), integer_format)
        else:
            for column in ('B', 'D', 'E'):
                daily.write(f'{column}{index}', 'Нет данных', cell_center)
        previous_row = daily_stats[index - 3] if index > 2 else None
        previous_activity_available = previous_row and previous_row.get(
            'activity_available', previous_row.get('dau') is not None
        )
        dau_delta = previous_day_percent_delta(
            row_data.get('dau'), previous_row.get('dau') if previous_activity_available else None
        )
        if dau_delta is None or not activity_available:
            daily.write(f'C{index}', 'н/д', cell_center)
        else:
            daily.write_formula(
                f'C{index}',
                f'=IF(OR(NOT(ISNUMBER(B{index - 1})),B{index - 1}=0),"",B{index}/B{index - 1}-1)',
                percent_format,
                dau_delta
            )
        daily.write_number(f'F{index}', number(row_data.get('registrations')), integer_format)
        daily.write_number(f'G{index}', number(row_data.get('downloads')), integer_format)
        daily.write_number(f'H{index}', number(row_data.get('limits')), integer_format)
        daily.write_number(f'I{index}', number(row_data.get('revenue_rub')), currency_format)
        rub_delta = previous_day_percent_delta(
            row_data.get('revenue_rub'), previous_row.get('revenue_rub') if previous_row else None
        )
        if rub_delta is None:
            daily.write(f'J{index}', 'н/д', cell_center)
        else:
            daily.write_formula(f'J{index}', f'=IF(I{index - 1}=0,"",I{index}/I{index - 1}-1)', percent_format, rub_delta)
        daily.write_number(f'K{index}', number(row_data.get('revenue_stars')), stars_format)
        stars_delta = previous_day_percent_delta(
            row_data.get('revenue_stars'), previous_row.get('revenue_stars') if previous_row else None
        )
        if stars_delta is None:
            daily.write(f'L{index}', 'н/д', cell_center)
        else:
            daily.write_formula(f'L{index}', f'=IF(K{index - 1}=0,"",K{index}/K{index - 1}-1)', percent_format, stars_delta)
    daily_last_row = max(2, len(daily_stats) + 1)
    if daily_stats:
        daily.autofilter(f'A1:L{daily_last_row}')
        for column in ('C', 'J', 'L'):
            add_change_formatting(daily, f'{column}2:{column}{daily_last_row}', positive_format, negative_format, neutral_format)
        daily.conditional_format(f'B2:B{daily_last_row}', {
            'type': '3_color_scale', 'min_color': '#FEE4E2', 'mid_color': '#FEF0C7', 'max_color': '#D1FADF'
        })
    daily.freeze_panes(1, 0)
    safe_autofit(daily)
    daily.set_column('A:A', 13)
    daily.set_column('C:C', 12)
    daily.set_column('J:J', 12)
    daily.set_column('L:L', 12)

    # ================================================================
    # SHEET 9: Payment loss analytics
    # ================================================================
    payment_loss_sheet = workbook.add_worksheet(SHEET_PAYMENT_LOSS)
    configure_sheet(payment_loss_sheet, '#B54708')
    write_back_link(payment_loss_sheet, link_format)
    payment_loss_sheet.write('B2', 'Почему не купили', section_title_format)
    payment_loss_sheet.write('B3', f'Уникальные пользователи · окно атрибуции 24 часа · {start_date} — {end_date}', subtitle_format)
    completeness = payment_loss.get('dataCompleteness', {})
    complete_from = completeness.get('completeFrom') or 'н/д'
    completeness_note = completeness.get('note') or 'Полнота событий не определена'
    payment_loss_sheet.merge_range(
        'B4:H4',
        f'Данные полноценно собираются с {complete_from}. {completeness_note}',
        summary_text_format
    )

    def write_optional_number(row, col, value, cell_format, divisor=1):
        if value is None or value == '':
            payment_loss_sheet.write(row, col, 'н/д', cell_center)
        else:
            payment_loss_sheet.write_number(row, col, number(value) / divisor, cell_format)

    payment_loss_sheet.write_row('B6', [
        'Этап', 'Уникальные пользователи', 'События', 'От предыдущего',
        'От входа', 'Потеря, чел.', 'Потеря, %'
    ], header_format)
    loss_funnel = payment_loss.get('funnel', [])
    for index, row_data in enumerate(loss_funnel, start=7):
        payment_loss_sheet.write(f'B{index}', row_data.get('label') or '—', cell_left)
        payment_loss_sheet.write_number(f'C{index}', number(row_data.get('users')), integer_format)
        payment_loss_sheet.write_number(f'D{index}', number(row_data.get('events')), integer_format)
        write_optional_number(index - 1, 4, row_data.get('conversionFromPrevious'), percent_format, 100)
        write_optional_number(index - 1, 5, row_data.get('conversionFromFirst'), percent_format, 100)
        write_optional_number(index - 1, 6, row_data.get('dropoutUsers'), integer_format)
        write_optional_number(index - 1, 7, row_data.get('dropoutPercent'), percent_format, 100)
    if loss_funnel:
        payment_loss_sheet.autofilter(f'B6:H{len(loss_funnel) + 6}')
        payment_loss_sheet.conditional_format(f'H7:H{len(loss_funnel) + 6}', {
            'type': '3_color_scale', 'min_color': '#D1FADF', 'mid_color': '#FEF0C7', 'max_color': '#FEE4E2'
        })

    plan_start = max(14, len(loss_funnel) + 9)
    payment_loss_sheet.write(plan_start, 1, 'Разрез по тарифам', section_title_format)
    payment_loss_sheet.write_row(plan_start + 2, 1, [
        'Тариф', 'Выбрали', 'Invoice', 'Pre-checkout', 'Оплатили',
        'Конверсия', 'Среднее время, сек.', 'Скачиваний до меню', 'Достигали лимита'
    ], header_format)
    for offset, row_data in enumerate(payment_loss.get('plans', []), start=plan_start + 3):
        payment_loss_sheet.write(offset, 1, row_data.get('plan') or '—', cell_left)
        for col, key in enumerate(['selectedUsers', 'invoiceUsers', 'preCheckoutUsers', 'paymentUsers'], start=2):
            payment_loss_sheet.write_number(offset, col, number(row_data.get(key)), integer_format)
        write_optional_number(offset, 6, row_data.get('conversion'), percent_format, 100)
        payment_loss_sheet.write_number(offset, 7, number(row_data.get('avgSecondsToPayment')), integer_format)
        payment_loss_sheet.write_number(offset, 8, number(row_data.get('avgDownloadsBefore')), integer_format)
        payment_loss_sheet.write_number(offset, 9, number(row_data.get('reachedLimitUsers')), integer_format)

    alternative = payment_loss.get('alternative', {})
    alt_row = plan_start + 9
    payment_loss_sheet.write(alt_row, 1, 'Альтернативная оплата', section_title_format)
    payment_loss_sheet.write_row(alt_row + 2, 1, ['Открыли', 'Оплатили RUB 24ч', 'Конверсия 24ч', 'Оплатили RUB 7д', 'Конверсия 7д'], header_format)
    payment_loss_sheet.write_number(alt_row + 3, 1, number(alternative.get('openedUsers')), integer_format)
    payment_loss_sheet.write_number(alt_row + 3, 2, number(alternative.get('paid24hUsers')), integer_format)
    write_optional_number(alt_row + 3, 3, alternative.get('conversion24h'), percent_format, 100)
    payment_loss_sheet.write_number(alt_row + 3, 4, number(alternative.get('paid7dUsers')), integer_format)
    write_optional_number(alt_row + 3, 5, alternative.get('conversion7d'), percent_format, 100)

    payment_loss_sheet.write_row(alt_row + 5, 1, ['Способ', 'Пользователи', 'Запросы', 'RUB 24ч', 'RUB 7д', 'Конверсия 24ч', 'Конверсия 7д', 'Среднее до оплаты, сек.'], header_format)
    for offset, row_data in enumerate(alternative.get('methods', []), start=alt_row + 6):
        payment_loss_sheet.write(offset, 1, row_data.get('method') or 'Другой способ', cell_left)
        for col, key in enumerate(['openedUsers', 'requestEvents', 'paid24hUsers', 'paid7dUsers'], start=2):
            payment_loss_sheet.write_number(offset, col, number(row_data.get(key)), integer_format)
        write_optional_number(offset, 6, row_data.get('conversion24h'), percent_format, 100)
        write_optional_number(offset, 7, row_data.get('conversion7d'), percent_format, 100)
        write_optional_number(offset, 8, row_data.get('avgSecondsToPayment'), integer_format)

    source_row = alt_row + max(12, len(alternative.get('methods', [])) + 9)
    payment_loss_sheet.write(source_row, 1, 'Источник последнего скачивания перед тарифами', section_title_format)
    payment_loss_sheet.write_row(source_row + 2, 1, ['Источник', 'Путь', 'Пользователи', 'Скачивания', 'Ошибки', 'Лимит', 'Выбор тарифа', 'Invoice', 'Pre-checkout', 'Платящие', 'Конверсия', 'D1', 'D7'], header_format)
    for offset, row_data in enumerate(payment_loss.get('contentSources', []), start=source_row + 3):
        payment_loss_sheet.write(offset, 1, row_data.get('source') or 'Не определён', cell_left)
        payment_loss_sheet.write(offset, 2, row_data.get('entrySource') or 'Не определён', cell_left)
        for col, key in enumerate(['users','successfulDownloads','errors','reachedLimitUsers','selectedUsers','invoiceUsers','preCheckoutUsers','payers'], start=3):
            write_optional_number(offset, col, row_data.get(key), integer_format)
        write_optional_number(offset, 11, row_data.get('conversion'), percent_format, 100)
        payment_loss_sheet.write_number(offset, 12, number(row_data.get('returnedD1')), integer_format)
        payment_loss_sheet.write_number(offset, 13, number(row_data.get('returnedD7')), integer_format)

    error_row = source_row + max(8, len(payment_loss.get('contentSources', [])) + 5)
    payment_loss_sheet.write(error_row, 1, 'Подтверждённые ошибки оплаты', section_title_format)
    payment_loss_sheet.write_row(error_row + 2, 1, ['Категория', 'Пользователи', 'События'], header_format)
    for offset, row_data in enumerate(payment_loss.get('paymentErrors', []), start=error_row + 3):
        payment_loss_sheet.write(offset, 1, row_data.get('category') or 'Прочая техническая ошибка', cell_left)
        payment_loss_sheet.write_number(offset, 2, number(row_data.get('users')), integer_format)
        payment_loss_sheet.write_number(offset, 3, number(row_data.get('events')), integer_format)

    segment_row = error_row + max(8, len(payment_loss.get('paymentErrors', [])) + 5)
    payment_loss_sheet.write(segment_row, 1, 'Сегменты пользователей', section_title_format)
    payment_loss_sheet.write_row(segment_row + 2, 1, ['Сегмент', 'Пользователи', 'Платящие', 'Конверсия'], header_format)
    for offset, row_data in enumerate(payment_loss.get('segments', []), start=segment_row + 3):
        payment_loss_sheet.write(offset, 1, row_data.get('segment') or '—', cell_left)
        payment_loss_sheet.write_number(offset, 2, number(row_data.get('users')), integer_format)
        payment_loss_sheet.write_number(offset, 3, number(row_data.get('payers')), integer_format)
        write_optional_number(offset, 4, row_data.get('conversion'), percent_format, 100)

    behavior_row = segment_row + max(14, len(payment_loss.get('segments', [])) + 5)
    payment_loss_sheet.write(behavior_row, 1, 'Поведение после незавершённой оплаты', section_title_format)
    payment_loss_sheet.write_row(behavior_row + 2, 1, ['Метрика', 'Пользователи'], header_format)
    for offset, (key, value) in enumerate(payment_loss.get('postFunnel', {}).items(), start=behavior_row + 3):
        payment_loss_sheet.write(offset, 1, key, cell_left)
        payment_loss_sheet.write_number(offset, 2, number(value), integer_format)

    derived_row = behavior_row + max(15, len(payment_loss.get('postFunnel', {})) + 5)
    payment_loss_sheet.write(derived_row, 1, 'Производные метрики', section_title_format)
    payment_loss_sheet.write_row(derived_row + 2, 1, ['Метрика', 'Значение'], header_format)
    for offset, (key, value) in enumerate(payment_loss.get('derivedMetrics', {}).items(), start=derived_row + 3):
        payment_loss_sheet.write(offset, 1, key, cell_left)
        write_optional_number(offset, 2, value, cell_center)

    context_row = derived_row + max(15, len(payment_loss.get('derivedMetrics', {})) + 5)
    payment_loss_sheet.write(context_row, 1, 'Контекст скачиваний', section_title_format)
    payment_loss_sheet.write_row(context_row + 2, 1, ['Метрика', 'Значение'], header_format)
    download_context = payment_loss.get('downloadContext', {})
    for offset, (key, value) in enumerate(download_context.items(), start=context_row + 3):
        payment_loss_sheet.write(offset, 1, key, cell_left)
        if isinstance(value, (list, dict)):
            payment_loss_sheet.write(offset, 2, ', '.join(value) if isinstance(value, list) else json.dumps(value, ensure_ascii=False), cell_left)
        elif isinstance(value, bool):
            payment_loss_sheet.write(offset, 2, 'да' if value else 'нет', cell_center)
        else:
            write_optional_number(offset, 2, value, cell_center)

    contract_row = context_row + max(14, len(download_context) + 5)
    payment_loss_sheet.write(contract_row, 1, 'Аудит контракта событий', section_title_format)
    payment_loss_sheet.write_row(contract_row + 2, 1, [
        'Событие', 'События', 'Пользователи', 'plan', 'placement',
        'order_id', 'payment_method', 'source', 'deduplication_key'
    ], header_format)
    for offset, row_data in enumerate(payment_loss.get('eventContract', []), start=contract_row + 3):
        fields = row_data.get('fields', {})
        payment_loss_sheet.write(offset, 1, row_data.get('eventName') or '—', cell_left)
        payment_loss_sheet.write_number(offset, 2, number(row_data.get('events')), integer_format)
        payment_loss_sheet.write_number(offset, 3, number(row_data.get('users')), integer_format)
        for col, key in enumerate(['plan', 'placement', 'orderId', 'paymentMethod', 'source', 'deduplicationKey'], start=4):
            payment_loss_sheet.write(offset, col, 'да' if fields.get(key) else 'нет', cell_center)

    payment_loss_sheet.freeze_panes(6, 1)
    safe_autofit(payment_loss_sheet)
    payment_loss_sheet.set_column('B:B', 32)

    workbook.close()
    print(f'Excel report successfully generated: {os.path.basename(output_path)}')


if __name__ == '__main__':
    main()
