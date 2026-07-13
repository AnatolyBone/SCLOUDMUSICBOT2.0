# scripts/generate_excel_report.py
import sys
import json
import os
import xlsxwriter

def number(value, default=0):
    """Normalize PostgreSQL bigint/numeric JSON strings and NULL for xlsxwriter."""
    if value is None or value == '':
        return default
    try:
        parsed = float(value)
        return int(parsed) if parsed.is_integer() else parsed
    except (TypeError, ValueError):
        return default

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_excel_report.py <input_json_path> <output_xlsx_path>")
        sys.exit(1)

    json_path = sys.argv[1]
    output_path = sys.argv[2]

    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    workbook = xlsxwriter.Workbook(output_path)

    # ----------------------------------------------------
    # Styles & Formatting
    # ----------------------------------------------------
    # Premium Dark Blue/Indigo Palette
    title_fmt = workbook.add_format({
        'bold': True, 'size': 16, 'font_name': 'Segoe UI', 'font_color': '#1f4e78'
    })
    subtitle_fmt = workbook.add_format({
        'italic': True, 'size': 10, 'font_name': 'Segoe UI', 'font_color': '#595959'
    })
    
    header_fmt = workbook.add_format({
        'bold': True, 'size': 11, 'font_name': 'Segoe UI', 'font_color': '#ffffff',
        'bg_color': '#1f4e78', 'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#d9d9d9'
    })
    
    # Grid Data Styles
    cell_center = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#e0e0e0'
    })
    cell_left = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'left', 'valign': 'vcenter', 'border': 1, 'border_color': '#e0e0e0'
    })
    cell_right = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'valign': 'vcenter', 'border': 1, 'border_color': '#e0e0e0'
    })
    
    # Numeric Formats
    num_integer = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '#,##0', 'border': 1, 'border_color': '#e0e0e0'
    })
    num_currency = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '#,##0.00" ₽"', 'border': 1, 'border_color': '#e0e0e0'
    })
    num_stars = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '⭐️ #,##0', 'border': 1, 'border_color': '#e0e0e0'
    })
    num_pct = workbook.add_format({
        'font_name': 'Segoe UI', 'align': 'right', 'num_format': '0.00"%"', 'border': 1, 'border_color': '#e0e0e0'
    })

    # Summary Card Styles (Dashboard Grid)
    card_label_fmt = workbook.add_format({
        'size': 9, 'font_name': 'Segoe UI', 'font_color': '#595959', 'bg_color': '#f2f2f2',
        'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#d9d9d9'
    })
    card_val_fmt = workbook.add_format({
        'bold': True, 'size': 14, 'font_name': 'Segoe UI', 'font_color': '#1f4e78', 'bg_color': '#f2f2f2',
        'align': 'center', 'valign': 'vcenter', 'border': 1, 'border_color': '#d9d9d9'
    })

    # ====================================================
    # SHEET 1: Dashboard
    # ====================================================
    dash = workbook.add_worksheet('Dashboard')
    dash.set_zoom(90)
    dash.set_column('A:A', 3)
    dash.set_column('B:E', 25)
    dash.set_column('F:I', 15)

    dash.write('B2', 'ОТЧЕТ ПО АНАЛИТИКЕ БОТА (SCloudMusicBot)', title_fmt)
    dash.write('B3', f'Период: {data["startDate"]} - {data["endDate"]} | Сгенерирован автоматически', subtitle_fmt)

    # Render Summary Cards in B5:D7
    summary = data['summary']
    cards = [
        ('Всего пользователей', summary['total_users'], num_integer),
        ('Новых за период', summary['new_users'], num_integer),
        ('Средний DAU', summary['avg_dau'], num_integer),
        ('Средний WAU', summary['avg_wau'], num_integer),
        ('Средний MAU', summary['avg_mau'], num_integer),
        ('Всего скачиваний', summary['total_downloads'], num_integer),
        ('Выручка RUB', summary['revenue_rub'], num_currency),
        ('Выручка Stars', summary['revenue_stars'], num_stars),
        ('Кол-во оплат', summary['payments_count'], num_integer)
    ]

    for idx, (label, val, fmt) in enumerate(cards):
        col = (idx % 3) + 1  # B, C, D (columns 1, 2, 3)
        row = (idx // 3) * 3 + 5 # Rows 5, 8, 11
        
        dash.merge_range(row, col, row, col, label, card_label_fmt)
        dash.write(row + 1, col, val, card_val_fmt)
        # Apply formatting if it is currency/stars
        if fmt == num_currency:
            dash.write_number(row + 1, col, number(val), workbook.add_format({'bold':True, 'size':14, 'font_color':'#2e75b6', 'bg_color':'#f2f2f2', 'align':'center', 'num_format':'#,##0.00" ₽"', 'border':1, 'border_color':'#d9d9d9'}))
        elif fmt == num_stars:
            dash.write_number(row + 1, col, number(val), workbook.add_format({'bold':True, 'size':14, 'font_color':'#e2b13c', 'bg_color':'#f2f2f2', 'align':'center', 'num_format':'⭐️ #,##0', 'border':1, 'border_color':'#d9d9d9'}))
        else:
            dash.write_number(row + 1, col, number(val), card_val_fmt)

    # We will insert charts from Sheet 7 (Daily Stats) onto the Dashboard
    # Chart 1: DAU / WAU / MAU
    chart1 = workbook.add_chart({'type': 'line'})
    chart1.set_title({'name': 'Активность пользователей (DAU / WAU / MAU)', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    chart1.set_size({'width': 780, 'height': 320})
    
    # We reference data in 'Daily Stats' Sheet 7
    # Note: Sheet 7 columns are: A: Date, B: DAU, C: WAU, D: MAU, E: Registrations, F: Downloads...
    num_rows = len(data['daily_stats'])
    if num_rows > 0:
        chart1.add_series({
            'name':       '=\'Дневная статистика\'!$B$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$B$2:$B${num_rows + 1}',
            'line':       {'color': '#4e73df', 'width': 2.0},
        })
        chart1.add_series({
            'name':       '=\'Дневная статистика\'!$C$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$C$2:$C${num_rows + 1}',
            'line':       {'color': '#36b9cc', 'width': 1.5, 'dash_type': 'dash'},
        })
        chart1.add_series({
            'name':       '=\'Дневная статистика\'!$D$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$D$2:$D${num_rows + 1}',
            'line':       {'color': '#1cc88a', 'width': 1.5},
        })
        dash.insert_chart('B15', chart1)

    # Chart 2: Downloads
    chart2 = workbook.add_chart({'type': 'area'})
    chart2.set_title({'name': 'Динамика скачиваний (всего)', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    chart2.set_size({'width': 380, 'height': 240})
    if num_rows > 0:
        chart2.add_series({
            'name':       '=\'Дневная статистика\'!$F$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$F$2:$F${num_rows + 1}',
            'fill':       {'color': '#4e73df', 'transparency': 70},
            'line':       {'color': '#4e73df', 'width': 1.5},
        })
        dash.insert_chart('B32', chart2)

    # Chart 3: Revenue (RUB & Stars)
    chart3 = workbook.add_chart({'type': 'column'})
    chart3.set_title({'name': 'Ежедневная выручка', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    chart3.set_size({'width': 380, 'height': 240})
    if num_rows > 0:
        chart3.add_series({
            'name':       '=\'Дневная статистика\'!$H$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$H$2:$H${num_rows + 1}',
            'fill':       {'color': '#1cc88a'},
        })
        # Double axis for stars is complex, so we just show RUB in columns, or stars as secondary
        chart3.add_series({
            'name':       '=\'Дневная статистика\'!$I$1',
            'categories': f'=\'Дневная статистика\'!$A$2:$A${num_rows + 1}',
            'values':     f'=\'Дневная статистика\'!$I$2:$I${num_rows + 1}',
            'fill':       {'color': '#f6c23e'},
        })
        dash.insert_chart('C32', chart3)

    # ====================================================
    # SHEET 2: Воронка продаж
    # ====================================================
    fun = workbook.add_worksheet('Воронка продаж')
    fun.set_column('B:B', 30)
    fun.set_column('C:D', 15)
    
    fun.write('B2', 'ВОРОНКА ПРОДАЖ ТАРИФОВ', title_fmt)
    fun.write('B3', 'Конверсия пользователей по ключевым этапам', subtitle_fmt)
    
    fun.write_row('B5', ['Этап воронки', 'Количество', 'Конверсия от входа', 'Конверсия от пред.'], header_fmt)
    
    funnel_data = data['funnel']
    first_funnel_count = number(funnel_data[0].get('count')) if len(funnel_data) > 0 else 0
    total_entered = first_funnel_count if first_funnel_count > 0 else 1
    
    prev_count = total_entered
    for i, row in enumerate(funnel_data):
        curr_row = 6 + i
        fun.write(f'B{curr_row}', row['stage'], cell_left)
        fun.write_number(f'C{curr_row}', number(row.get('count')), num_integer)
        
        # formulas for conversions
        current_count = number(row.get('count'))
        pct_of_total = current_count / total_entered
        pct_of_prev = current_count / prev_count if prev_count > 0 else 0
        
        fun.write_number(f'D{curr_row}', pct_of_total, num_pct)
        fun.write_number(f'E{curr_row}', pct_of_prev, num_pct)
        
        prev_count = current_count

    # Add Funnel Bar Chart
    fchart = workbook.add_chart({'type': 'bar'})
    fchart.set_title({'name': 'Воронка продаж (количество пользователей)', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    fchart.set_size({'width': 600, 'height': 300})
    fchart.add_series({
        'name':       '=\'Воронка продаж\'!$C$5',
        'categories': f'=\'Воронка продаж\'!$B$6:$B${len(funnel_data) + 5}',
        'values':     f'=\'Воронка продаж\'!$C$6:$C${len(funnel_data) + 5}',
        'fill':       {'color': '#4e73df'},
    })
    fun.insert_chart('B16', fchart)

    # ====================================================
    # SHEET 3: Тарифы
    # ====================================================
    tar = workbook.add_worksheet('Тарифы')
    tar.set_column('B:E', 15)
    
    tar.write('B2', 'ПОПУЛЯРНОСТЬ ТАРИФНЫХ ПЛАНОВ', title_fmt)
    tar.write('B3', 'Ежедневное количество завершенных оплат по планам', subtitle_fmt)
    
    tar.write_row('B5', ['Дата', 'Plus', 'Pro', 'Unlimited'], header_fmt)
    
    tariff_rows = data['tariffs']
    for idx, row in enumerate(tariff_rows):
        curr_row = 6 + idx
        tar.write(f'B{curr_row}', row['day'], cell_center)
        tar.write_number(f'C{curr_row}', number(row.get('plus')), num_integer)
        tar.write_number(f'D{curr_row}', number(row.get('pro')), num_integer)
        tar.write_number(f'E{curr_row}', number(row.get('unlim')), num_integer)

    # Tariff chart
    tchart = workbook.add_chart({'type': 'line'})
    tchart.set_title({'name': 'Популярность тарифов по дням', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    tchart.set_size({'width': 650, 'height': 300})
    if len(tariff_rows) > 0:
        tchart.add_series({
            'name':       '=\'Тарифы\'!$C$5',
            'categories': f'=\'Тарифы\'!$B$6:$B${len(tariff_rows) + 5}',
            'values':     f'=\'Тарифы\'!$C$6:$C${len(tariff_rows) + 5}',
            'line':       {'color': '#4e73df', 'width': 2},
        })
        tchart.add_series({
            'name':       '=\'Тарифы\'!$D$5',
            'categories': f'=\'Тарифы\'!$B$6:$B${len(tariff_rows) + 5}',
            'values':     f'=\'Тарифы\'!$D$6:$D${len(tariff_rows) + 5}',
            'line':       {'color': '#1cc88a', 'width': 2},
        })
        tchart.add_series({
            'name':       '=\'Тарифы\'!$E$5',
            'categories': f'=\'Тарифы\'!$B$6:$B${len(tariff_rows) + 5}',
            'values':     f'=\'Тарифы\'!$E$6:$E${len(tariff_rows) + 5}',
            'line':       {'color': '#f6c23e', 'width': 2},
        })
        tar.insert_chart('G5', tchart)

    # ====================================================
    # SHEET 4: Платежи
    # ====================================================
    pay = workbook.add_worksheet('Платежи')
    pay.set_column('B:G', 16)
    
    pay.write('B2', 'ИСТОРИЯ И ДЕТАЛИЗАЦИЯ ПЛАТЕЖЕЙ', title_fmt)
    pay.write('B3', 'Список успешных оплат за период', subtitle_fmt)
    
    pay.write_row('B5', ['Дата', 'Метод оплаты', 'Валюта', 'Сумма', 'Тариф', 'Количество оплат'], header_fmt)
    
    payments = data['payments']
    for idx, row in enumerate(payments):
        curr_row = 6 + idx
        pay.write(f'B{curr_row}', row['date'], cell_center)
        pay.write(f'C{curr_row}', row['method'], cell_left)
        pay.write(f'D{curr_row}', row['currency'], cell_center)
        
        if row['currency'] == 'RUB':
            pay.write_number(f'E{curr_row}', number(row.get('amount')), num_currency)
        else:
            pay.write_number(f'E{curr_row}', number(row.get('amount')), num_stars)
            
        pay.write(f'F{curr_row}', (row['plan'] or '—').upper(), cell_center)
        pay.write_number(f'G{curr_row}', number(row.get('count')), num_integer)

    # Summary table: RUB vs Stars
    pay.write('I5', 'Тип валюты', header_fmt)
    pay.write('J5', 'Общая выручка', header_fmt)
    
    pay.write('I6', 'Российский рубль (RUB)', cell_left)
    # formula sum for RUB
    pay.write_formula('J6', f'=SUMIF(D6:D{len(payments)+5}, "RUB", E6:E{len(payments)+5})', num_currency)
    
    pay.write('I7', 'Telegram Stars (XTR)', cell_left)
    pay.write_formula('J7', f'=SUMIF(D6:D{len(payments)+5}, "XTR", E6:E{len(payments)+5})', num_stars)

    # ====================================================
    # SHEET 5: Рассылки
    # ====================================================
    camp = workbook.add_worksheet('Рассылки')
    camp.set_column('B:B', 6)
    camp.set_column('C:D', 20)
    camp.set_column('E:E', 12)
    camp.set_column('F:I', 15)
    
    camp.write('B2', 'ЭФФЕКТИВНОСТЬ РАССЫЛОК (CAMPAIGNS)', title_fmt)
    camp.write('B3', 'Анализ воронки доставок, кликов и последующих 24ч конверсий', subtitle_fmt)
    
    camp.write_row('B5', ['ID', 'Кампания', 'Тег (UTM)', 'Дата', 'Получатели', 'Доставлено', 'Клики', 'CTR', 'Оплаты (24ч)'], header_fmt)
    
    campaigns = data['campaigns']
    for idx, row in enumerate(campaigns):
        curr_row = 6 + idx
        camp.write_number(f'B{curr_row}', number(row.get('id')), num_integer)
        camp.write(f'C{curr_row}', row['name'] or 'Без названия', cell_left)
        camp.write(f'D{curr_row}', row['tag'] or '—', cell_center)
        camp.write(f'E{curr_row}', row['date'], cell_center)
        camp.write_number(f'F{curr_row}', number(row.get('recipients')), num_integer)
        camp.write_number(f'G{curr_row}', number(row.get('delivered')), num_integer)
        camp.write_number(f'H{curr_row}', number(row.get('clicks')), num_integer)
        
        # CTR formula: clicks / delivered
        camp.write_formula(f'I{curr_row}', f'=IF(G{curr_row}>0, H{curr_row}/G{curr_row}, 0)', num_pct)
        camp.write_number(f'J{curr_row}', number(row.get('conversions_24h')), num_integer)

    # ====================================================
    # SHEET 6: Языковые сегменты
    # ====================================================
    langs = workbook.add_worksheet('Языковые сегменты')
    langs.set_column('B:E', 18)
    
    langs.write('B2', 'ЯЗЫКОВЫЕ СЕГМЕНТЫ ПОЛЬЗОВАТЕЛЕЙ', title_fmt)
    langs.write('B3', 'Распределение базы по языкам, активности и оплатам', subtitle_fmt)
    
    langs.write_row('B5', ['Языковой код', 'Всего пользователей', 'Активных за период', 'Платящих пользователей'], header_fmt)
    
    lang_rows = data['languages']
    for idx, row in enumerate(lang_rows):
        curr_row = 6 + idx
        langs.write(f'B{curr_row}', row['language'], cell_center)
        langs.write_number(f'C{curr_row}', number(row.get('users')), num_integer)
        langs.write_number(f'D{curr_row}', number(row.get('active')), num_integer)
        langs.write_number(f'E{curr_row}', number(row.get('payments')), num_integer)

    # Add Pie Chart for languages
    lchart = workbook.add_chart({'type': 'pie'})
    lchart.set_title({'name': 'Распределение аудитории по языкам', 'name_font': {'name': 'Segoe UI', 'size': 12, 'bold': True}})
    lchart.set_size({'width': 450, 'height': 250})
    if len(lang_rows) > 0:
        lchart.add_series({
            'name':       'Языки',
            'categories': f'=\'Языковые сегменты\'!$B$6:$B${len(lang_rows) + 5}',
            'values':     f'=\'Языковые сегменты\'!$C$6:$C${len(lang_rows) + 5}',
        })
        langs.insert_chart('G5', lchart)

    # ====================================================
    # SHEET 7: Дневная статистика (Raw Table)
    # ====================================================
    ds = workbook.add_worksheet('Дневная статистика')
    ds.set_column('A:I', 15)
    
    ds.write_row('A1', ['Дата', 'DAU', 'WAU', 'MAU', 'Регистрации', 'Скачивания', 'Лимиты', 'Выручка (RUB)', 'Выручка (Stars)'], header_fmt)
    
    daily_stats = data['daily_stats']
    for idx, row in enumerate(daily_stats):
        curr_row = 2 + idx
        ds.write(f'A{curr_row}', row['day'], cell_center)
        ds.write_number(f'B{curr_row}', number(row.get('dau')), num_integer)
        ds.write_number(f'C{curr_row}', number(row.get('wau')), num_integer)
        ds.write_number(f'D{curr_row}', number(row.get('mau')), num_integer)
        ds.write_number(f'E{curr_row}', number(row.get('registrations')), num_integer)
        ds.write_number(f'F{curr_row}', number(row.get('downloads')), num_integer)
        ds.write_number(f'G{curr_row}', number(row.get('limits')), num_integer)
        ds.write_number(f'H{curr_row}', number(row.get('revenue_rub')), num_currency)
        ds.write_number(f'I{curr_row}', number(row.get('revenue_stars')), num_stars)

    # Close workbook
    workbook.close()
    print("Excel report successfully generated!")

if __name__ == '__main__':
    main()
