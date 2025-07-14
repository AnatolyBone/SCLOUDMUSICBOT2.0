$(document).ready(function() {
    // DataTables для таблицы пользователей
    $("#usersTable").DataTable({
      paging: true,
      searching: true,
      ordering: true,
      order: [[0, "desc"]],
      scrollX: true,
      language: {
        url: "/static/js/datatables-ru.json"
      }
    });

    // Пагинация для списка истекающих подписок
    window.changePage = function(dir) {
      const url = new URL(window.location.href);
      let offset = parseInt(url.searchParams.get("expiringOffset")) || 0;
      offset += dir * <%= expiringLimit %>;
      if (offset < 0) offset = 0;
      url.searchParams.set("expiringOffset", offset);
      window.location.href = url.toString();
    };

    // Графики на Chart.js

    // Регистрации, загрузки, активные
    const combinedCtx = document.getElementById("combinedChart").getContext("2d");
    new Chart(combinedCtx, {
      type: "line",
      data: <%- JSON.stringify(chartDataCombined || {}) %>,
      options: {
        responsive: true,
        plugins: { legend: { position: "top" } },
        scales: { y: { beginAtZero: true } }
      }
    });

    // Активность по часам
    const hourCtx = document.getElementById("hourActivityChart").getContext("2d");
    new Chart(hourCtx, {
      type: "bar",
      data: <%- JSON.stringify(chartDataHourActivity || {}) %>,
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });

    // Активность по дням недели
    const weekdayCtx = document.getElementById("weekdayActivityChart").getContext("2d");
    new Chart(weekdayCtx, {
      type: "bar",
      data: <%- JSON.stringify(chartDataWeekdayActivity || {}) %>,
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });

    // Тепловая карта
    const heatmapCtx = document.getElementById("heatmapChart").getContext("2d");
    new Chart(heatmapCtx, {
      type: "bar", // Можно заменить на "matrix" с плагином, если нужен эффект тепловой карты
      data: <%- JSON.stringify(chartDataHeatmap || {}) %>,
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });

    // Воронка пользователей (горизонтальный бар)
    const funnelCtx = document.getElementById("funnelChart").getContext("2d");
    new Chart(funnelCtx, {
      type: "bar",
      data: <%- JSON.stringify(chartDataFunnel || {}) %>,
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true }
        },
        scales: {
          x: { beginAtZero: true, precision: 0 },
          y: { ticks: { font: { size: 14 } } }
        }
      }
    });

    // User Funnel (вертикальный)
    const userFunnelCtx = document.getElementById("userFunnelChart").getContext("2d");
    new Chart(userFunnelCtx, {
      type: "bar",
      data: <%- JSON.stringify(chartDataUserFunnel || {}) %>,
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });

    // Retention line chart
    const retentionCtx = document.getElementById("retentionChart").getContext("2d");
    new Chart(retentionCtx, {
      type: "line",
      data: <%- JSON.stringify(chartDataRetention || {}) %>,
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });
  });
