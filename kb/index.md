<!-- Реестр всех статей базы знаний.
     Правится вручную при добавлении или удалении статьи.
     Агент читает этот файл первым, чтобы найти путь к нужной статье.

     Файл состоит из трёх таблиц:
     «Домены» — карта тем и мастер-сущности каждой темы;
     «Сущности» — сам реестр статей;
     «Самостоятельные выгрузки» — отчёты-трансформеры для режима выгрузки,
     см. пояснение перед самой таблицей.

     Колонка «домен» есть только здесь, во фронтматтере статьи её нет:
     одно место — один источник, нечему разъезжаться. То же и с мастерством:
     оно живёт только в таблице «Домены».

     Колонка dd_urn — ключ объекта в Data Detective. Заполнена — состав полей,
     типы и описания агент берёт онлайн из DD, а не из текста статьи.
     Прочерк — сущности в DD нет (рецепты, метрики, регламенты).
     Строка может существовать и без пути к статье: объект зарегистрирован
     в DD, статья ещё не написана.

     ВСЕ URN ПОДТВЕРЖДЕНЫ ЖИВЫМ ЗАПРОСОМ 2026-09-01 — 20 таблиц и 5 отчётов
     отвечают на GET /entity/{urn} (Data Detective MCP). Битых ссылок нет.
     До этого живым запросом был подтверждён один URN — t-emp-structure,
     остальные собирались по схеме urn:dd:tables:greenplum:table:<схема>.<таблица>
     и могли дать 404.
     При добавлении новой строки с dd_urn проверяй URN живым запросом
     (GET /entity/{urn}) до коммита: неверный ключ молча лишает агента
     инвентаря полей, а по виду прогона это неотличимо от нормы. -->

# Реестр базы знаний

## Домены

Домен — тема вопроса. Он сужает поиск: определив домен, агент выбирает сущности
внутри него, а не по всему реестру.

Колонка «мастер» — сущности, которые в этом домене читаются **первыми и всегда**,
даже если вопрос выглядит узким. Мастер — это свойство пары «домен + сущность»,
а не сущности самой по себе: `t-emp-structure` мастер для численности, но когда
нужны все юридические позиции — берётся `t-legal-position` (см. `rc-structure-choice`).
Поэтому мастерство указано здесь, а не в строке сущности.

**`t-emp-structure` — мастер-витрина по сотрудникам.** Любой вопрос про людей
идёт в неё по умолчанию, включая вопросы про основную юридическую позицию.
Домен `legal` означает переход на `t-legal-position` только тогда, когда нужны
**все оформления** — совместительство, ГПХ, декретные позиции, оформления
в конкретном юрлице. Развилка «сотрудник или позиция» — шаг 0
в [`recipes/structure-choice.md`](recipes/structure-choice.md), и она выполняется
раньше разбора формулировок заказчика.

| домен | о чём вопросы | мастер |
|---|---|---|
| headcount-structure | численность, штат, сколько людей, сколько человек, ставки в штате, подразделение, команда, департамент, юнит, уровень иерархии, руководитель, кто в подчинении, грейд, специализация, должность, позиция сотрудника, стрим, табельный номер, покраска, HQ, BigOps, декрет, декретницы, отпуск по уходу за ребёнком | t-emp-structure, m-legal-headcount, rc-structure-choice |
| legal | оформление, трудовой договор, тип трудоустройства, юридическая позиция, структурное подразделение, юр. единица, юрлицо, трудоустроенные, совместительство, ГПХ, подрядчики, аутсорсинг, декретные позиции | t-legal-position, m-legal-headcount |
| movement | найм, приёмы, увольнения, текучесть, отток, стаж, когорты, нанятые за период, переводы, трансферы, перемещения сотрудников | t-emp-structure, rc-cohort-analysis |
| allocation | продукт, продуктовая структура, аллокация, FTE, загрузка на продукт, функциональная роль | t-functional-role, m-fte-product |
| attendance | табель, посещаемость, отсутствия, больничные, отпуска, отработанные дни, дневная активность, часы работы, продолжительность работы | t-attendance |
| education | образование, вуз, дипломы, студенты, квалификация | t-education |
| personal-attributes | оценки, ревью, дисциплинарные взыскания, город проживания, место жительства, дети сотрудников, заявления сотрудников, дополнительные чувствительные атрибуты сотрудника | t-emp-structure |
| meetings | встречи, собрания, переговорки, события календаря Outlook, бронирование переговорки, организатор встречи, встречи сотрудника, комнаты ktalk | t-calendar-event |

Домен `*` в строке сущности означает сквозную сущность: она относится к любому
домену и читается по релевантности вопроса, а не по совпадению домена.

Домен дробится, когда сущностей в нём становится больше десяти: до этого
дробление не сужает поиск, а только добавляет поводов ошибиться при выборе.
Новый домен — правка этой таблицы, а не значение, придуманное в строке сущности:
валидатор не пропустит домен, которого здесь нет.

## Сущности

| id | тип | домен | название | путь | dd_urn | алиасы | статус | описание |
|---|---|---|---|---|---|---|---|---|
| m-active-headcount | metric | headcount-structure | Активная численность | kb/metrics/active-headcount.md | — | активная численность, HC, headcount, сколько людей, численность, активные сотрудники | active | Управленческая численность: active_employee_flg = 1 и company_fire_flg = 0 |
| m-attribute-tenure | metric | movement | Стаж в атрибуте | kb/metrics/attribute-tenure.md | — | стаж, стаж в специализации, стаж в должности, стаж в грейде, как давно в подразделении, tenure, опыт в роли | active | Стаж внутри значения атрибута. Не путать со стажем в компании |
| m-fte-product | metric | allocation | FTE по продукту | kb/metrics/fte-by-product.md | — | FTE, аллокация, ставки, загрузка на продукт, allocation, full-time equivalent | active | Сумма allocation_prt. Не равно численности на продукте |
| m-hiring | metric | movement | Найм | kb/metrics/hiring.md | — | найм, hiring, приёмы, сколько наняли, набор, hiring rate | active | Два разных расчёта: по юридической и по активной численности |
| m-legal-headcount | metric | headcount-structure, legal | Юридическая численность | kb/metrics/legal-headcount.md | — | юридическая численность, оформленные, трудоустроенные, списочная численность, юрчисленность | active | Основная численность для расчётов: legal_employee_flg = 1 |
| m-turnover | metric | movement | Текучесть | kb/metrics/turnover.md | — | текучесть, текучка, turnover, отток, уволенные, retention, turnover rate | active | Уволенные / средняя численность. Период нужен на месяц шире |
| r-ambassadorstvo | report | personal-attributes | Амбассадорство сотрудников | kb/reports/ambassadorstvo.md | urn:dd:reports:reports:report:ambassadorstvo-vneproektnye-aktivnosti-sotrudnikov | амбассадорство, амбассадоры, программа амбассадоры, участие в амбассадорстве, амбассадорство сотрудников | active | Отчёт об участии сотрудников в программе Амбассадоры: время на активности, частота участия и доля участвующих от численности. RLS |
| r-attendance-calendar | report | attendance | Календарь присутствия сотрудников | kb/reports/attendance-calendar.md | urn:dd:reports:reports:report:2529 | календарь присутствия, расписание сотрудника, присутствие на каждый день | active | Отчёт по табелю: расписание присутствия/отсутствия сотрудника на каждый день. RLS для сокрытия чувствительных данных |
| r-avatar-center | report | education | Центр развития Аватар | kb/reports/avatar-center.md | urn:dd:reports:reports:report:1946 | центр развития аватар, аватар, программа аватар, crossdata центр развития аватар, центр развития автар | active | Отчёт по количеству сотрудников, которые прошли программу Аватар. RLS |
| r-btk-location | report | personal-attributes | БТК. Местоположение и заявления для возврата почтой РФ | kb/reports/btk-location.md | urn:dd:reports:reports:report:2088 | бтк, местоположение бтк, заявления для возврата трудовой книжки, возврат бумажных трудовых книжек почтой, возврат трудовой книжки при увольнении, переход на электронную трудовую книжку | active | Отчёт с данными по местоположению БТК и со списком активных заявлений на возврат бумажных трудовых книжек почтой РФ (при увольнении и переходе на ЭТК) |
| r-daily-activity-detail | report | attendance | Детализация дневной активности | kb/reports/daily-activity-detail.md | urn:dd:reports:reports:report:2115 | детализация дневной активности, активность сотрудника за день, дневная активность сотрудника, активность в скоупах | active | Приблизительный анализ активности сотрудника в нескольких скоупах. RLS |
| r-employment-period | report | headcount-structure | Периоды работы сотрудника | kb/reports/employment-period.md | urn:dd:reports:reports:report:2680 | периоды работы, период работы в банке, период работы в т-банке | active | Поиск и анализ физических лиц и их периодов работы в Т-Банке. RLS для сокрытия чувствительных данных |
| r-gitlab-activity | report | personal-attributes | Активность в GitLab | kb/reports/gitlab-activity.md | urn:dd:reports:reports:report:aktivnost-v-gitlab | активность в gitlab, gitlab активность, активность в git, метрики gitlab, активность разработчиков в gitlab | active | Метрики активности сотрудников в GitLab. RLS |
| r-hr-detail-list | report | headcount-structure | HR Executive — Детальные списки | kb/reports/hr-detail-list.md | urn:dd:reports:reports:report:1728 | hr executive, детальные списки, executive detail employee, детальный список сотрудников | active | Отчёт-трансформер: настраиваемая выгрузка атрибутов по сотрудникам. Лимит 150k строк, RLS, вкладки выгрузки |
| r-hr-executive-report | report | headcount-structure, movement | HR Executive Report | kb/reports/hr-executive-report.md | urn:dd:reports:reports:report:1845 | hr executive report, динамика численности, статистика найма и оттока, переводы, текучесть в динамике | active | Аналитика динамики HR-метрик: численность, найм, отток, переводы. Включает HQ Светофор с целями текучести |
| r-legal-position-period | report | legal | Юридические позиции сотрудника за период | kb/reports/legal-position-period.md | urn:dd:reports:reports:report:1801 | юридические позиции за период, юр позиции за период, позиции сотрудника за период | active | Сотрудники группы компаний с атрибутами юрструктуры и всеми юр позициями за период, включая совместительство. RLS для сокрытия чувствительных данных |
| r-ok-rs | report | personal-attributes | Отчет по ОК РС | kb/reports/ok-rs.md | urn:dd:reports:reports:report:1804 | отчет по ок рс, ок рс, оценочные конференции руководителей секторов, оценка руководителей секторов, rs assessment | active | Результаты оценочных конференций Руководителей Секторов. RLS |
| r-online-meetings-hq | report | meetings | Онлайн-встречи сотрудников HQ | kb/reports/online-meetings-hq.md | urn:dd:reports:reports:report:2275 | онлайн встречи сотрудников, загруженность встречами, встречи в толке, онлайн встречи сотрудников hq, встречи сотрудников на уровне -1 -2 | active | Загруженность встречами в Толке сотрудников уровня -1, -2. По умолчанию встречи 3+ участников с логами Толка. RLS |
| r-payment-details | report | legal | Платежные реквизиты по юридическим позициям | kb/reports/payment-details.md | urn:dd:reports:reports:report:2330 | платежные реквизиты, платежные документы сотрудников, реквизиты по юридическим позициям, наличие платежных документов, payments requsites | active | Наличие платежных документов по всем юридическим позициям сотрудников и исполнителей. RLS |
| r-referral-support | report | personal-attributes | Поддержка программы Приведи друга | kb/reports/referral-support.md | urn:dd:reports:reports:report:2048 | приведи друга, поддержка программы приведи друга, запросы в поддержку приведи друга, referral support, cross sd поддержка программы приведи друга | active | Запросы в поддержку программы Приведи друга из чата MyT и Forge, аналитика производительности и SLA. RLS |
| rc-attribute-tenure | recipe | movement | Стаж в атрибуте через gaps & islands | kb/recipes/attribute-tenure.md | — | gaps and islands, острова, шаблон стажа, tenure_in_attribute, стаж в атрибуте как считать | active | Алгоритм и готовый SQL v2.1, рядом файл attribute-tenure.sql |
| rc-cohort-analysis | recipe | movement | Когортный анализ | kb/recipes/cohort-analysis.md | — | когорта, нанятые в 2025, стажёры за период, атрибуты на дату события, потеряли уволенных, когортный анализ | active | Атрибуты на дату события, иначе уволенные теряются. Валидация численности |
| rc-field-synonyms | recipe | * | Словарь синонимов | kb/recipes/field-synonyms.md | — | словарь, синонимы, как называется поле, стрим, HQ, какое поле брать, специализация, грейд, покраска, BigOps, Big Ops, Non-HQ, Line, Support, IT, Digital, Non-IT | active | Слово заказчика в имя поля: покраска HQ/Line/Support и IT/Digital/Non-IT, 13 значений active_type_nm |
| rc-find-unit-level | recipe | headcount-structure, legal | Поиск уровня и ключа подразделения | kb/recipes/find-unit-level.md | — | найти подразделение, уровень подразделения, юнит, в каком юните, название юнита, двухшаговый поиск, какой lvl, mapped_management_unit_rk | active | Двухшаговый алгоритм: сначала уровень и ключ, потом выгрузка |
| rc-structure-choice | recipe | headcount-structure, legal, allocation | Выбор структуры и витрины | kb/recipes/structure-choice.md | — | какую витрину брать, юридическая или управленческая, структурное подразделение или команда, выбор источника, Т-Банк, Тбанк, вся компания, по всей компании | active | По формулировке заказчика определяет структуру и источник. Шаг −1: название компании фильтром не является |
| rc-unit-link | recipe | headcount-structure, allocation | Ссылка на юнит — как превратить её в ключ витрины | kb/recipes/unit-link.md | — | ссылка на юнит, id юнита, идентификатор юнита из ссылки, my.tbank.ru, ссылка на подразделение, ссылка на продукт, uuid юнита, как найти юнит по ссылке | active | Ссылка → id → rk → основные витрины. Вид ссылки определяет структуру: /structure/resource/units/ — управленческая, /product-catalog/product/ — Каталог продуктов |
| t-attendance | table | attendance | Табель посещаемости | kb/tables/mdm-employee-attendance.md | urn:dd:tables:greenplum:table:hrmart.mdm_employee_attendance | mdm_employee_attendance, табель, посещаемость, больничные, отсутствия, командировки, декреты сотрудников, неявки, отработанные дни | active | Гранулярность: сотрудник × день. Джойн по attendance_dt = business_dt. Обязателен фильтр etl_deleted_flg = 0 |
| t-calendar-event | table | meetings | События календаря Outlook | kb/tables/calendar-event.md | urn:dd:tables:greenplum:table:sse_crossdata.calendar_event | calendar_event, события календаря, события outlook, события в календаре, встречи, собрания | active | События Outlook: название, время, организатор, переговорки. Флаги regular/cancel/attendee |
| t-calendar-event-x-ktalk-room | table | meetings | Связь события и комнаты ktalk | kb/tables/calendar-event-x-ktalk-room.md | urn:dd:tables:greenplum:table:sse_crossdata.calendar_event_x_ktalk_room | calendar_event_x_ktalk_room, связь события и ktalk, ktalk комната события | active | Мост: событие Outlook ↔ комната ktalk по calendar_event_rk |
| t-calendar-event-x-mdm-employee | table | meetings | События календаря сотрудника | kb/tables/calendar-event-x-mdm-employee.md | urn:dd:tables:greenplum:table:sse_crossdata.calendar_event_x_mdm_employee | calendar_event_x_mdm_employee, события сотрудника в календаре, встречи сотрудника, организатор встречи | active | Мост: событие Outlook ↔ сотрудник (mdm_employee_rk). organizer_flg, accept_status_nm |
| t-calendar-event-x-meeting-room | table | meetings | Связь события и переговорки | kb/tables/calendar-event-x-meeting-room.md | urn:dd:tables:greenplum:table:sse_crossdata.calendar_event_x_meeting_room | calendar_event_x_meeting_room, связь события и переговорки, переговорка события, переговорка встречи | active | Мост: событие Outlook ↔ переговорка по email (unnest из meeting_room_email_address_txt_list) |
| t-crm-user | table | headcount-structure | Пользователи TWork | kb/tables/crm-user.md | urn:dd:tables:greenplum:table:dds.crm_user | crm_user, пользователи TWork, TWork, twork id, twork_id | active | Связь сотрудника с TWork через mdm_employee_rk. Обязателен джойн на период (valid_from_dttm/valid_to_dttm) и фильтры active_flg=1, deleted_flg=0. twork id = crm_user_id |
| t-disciplinary-sanction | table | personal-attributes | Дисциплинарные взыскания | kb/tables/disciplinary-sanction.md | urn:dd:tables:greenplum:table:sdp_itsa_zup.disciplinary_sanction | disciplinary_sanction, дисциплинарные взыскания, дисциплинарные взыскания сотрудников | active | Дисциплинарные взыскания сотрудников. Обязателен фильтр deleted_flg = false и posted_flg = true |
| t-dismissal-reason | table | movement | Причина увольнения от сотрудника | kb/tables/legal-position-dismissal-reason.md | urn:dd:tables:greenplum:table:hrmart.legal_position_dismissal_reason | legal_position_dismissal_reason, причины увольнения, комментарии причин увольнения | active | Причина увольнения со слов сотрудника. Джойн с t-emp-structure по legal_position_rk = legal_position_rk и legal_fire_dt = fire_dt |
| t-education | table | education | Образование сотрудников | kb/tables/mdm-employee-education.md | urn:dd:tables:greenplum:table:hrmart.mdm_employee_education | mdm_employee_education, образование, дипломы, вуз, студенты, квалификация | active | N записей на сотрудника, не подневная. Джойн без business_dt |
| t-emp-structure | table | headcount-structure, movement, personal-attributes | Ультраширокая витрина сотрудников | kb/tables/mdm-employee-structure-d.md | urn:dd:tables:greenplum:table:emart.mdm_employee_structure_d | mdm_employee_structure_d, ультраширокая, витрина сотрудников, основная витрина, emp_structure | active | Гранулярность: сотрудник × день, непрерывная. Основной источник |
| t-employee-children | table | personal-attributes | Данные о детях сотрудников | kb/tables/employee-children.md | urn:dd:tables:greenplum:table:chrono_peoplehub_masterid.individualchildren_public | individualchildren_public, дети сотрудников, данные о детях сотрудников | active | ПДн высокой чувствительности. Обязателен фильтр isdeleted = false и birthdate <= fire_dt |
| t-employee-client | table | headcount-structure | Связь сотрудника и клиента | kb/tables/mdm-employee-x-person-party.md | urn:dd:tables:greenplum:table:emart.mdm_employee_x_person_party | mdm_employee_x_person_party, employee_x_person_party, связь сотрудника и клиента, сотрудник-клиент, Siebel, Зибель | active | Связь между сотрудником и клиентом ФЛ. Фильтры: deleted_flg = 0, fire_flg = 0 |
| t-employee-profession | table | headcount-structure | Профессии сотрудников | kb/tables/employee-profession.md | urn:dd:tables:greenplum:table:dds_dic.employee_profession | employee_profession, профессия, профессии, классификатор профессий | active | Справочник профессий. Джойн только через мост employee_specialization, обязателен фильтр valid_to_dttm='5999-01-01' и deleted_flg=0 |
| t-employee-residence | table | personal-attributes | Город проживания сотрудника | kb/tables/employee-residence.md | urn:dd:tables:greenplum:table:sse_crossdata.employee_residence | employee_residence, город проживания, пребывание сотрудника | active | Джойн с t-emp-structure по mdm_employee_rk, срез на дату по valid_from_dttm/valid_to_dttm. Доступ закрыт группами, требуется согласование |
| t-employee-x-profession | table | headcount-structure | Прямая связь сотрудник-профессия | kb/tables/mdm-employee-x-profession.md | urn:dd:tables:greenplum:table:dds.mdm_employee_x_profession | mdm_employee_x_profession, лидеры профессий, наименование профессии | active | Обязателен фильтр last_day_flg = 1 при джойне с t-emp-structure. Возможное пересечение с t-employee-profession — не подтверждено |
| t-functional-role | table | allocation | Функциональные роли и аллокации | — | urn:dd:tables:greenplum:table:emart.functional_role_d | functional_role_d, продуктовая структура, аллокации, роли на продукте | active | Статьи нет: состав полей из DD. N строк на сотрудника, численность через count(distinct) |
| t-functional-unit | table | allocation | Справочник юнитов Каталога продуктов | kb/tables/functional-unit.md | urn:dd:tables:dlh:table:dds.functional_unit | functional_unit, dds.functional_unit, каталог продуктов, КП, структура каталога продуктов, функциональная структура, юниты каталога продуктов, functional_unit_id, functional_unit_rk, id продукта | active | Переводит id юнита из ссылки в functional_unit_rk. Версионная: valid_to_dttm='5999-01-01', close_flg=0. Поле management_unit_rk — мост в управленческую структуру |
| t-legal-position | table | legal | Юридические позиции сотрудников | kb/tables/legal-position-d.md | urn:dd:tables:greenplum:table:emart.legal_position_d | legal_position_d, юридическая структура, оформления, структурное подразделение, юр. позиции | active | Несколько оформлений на сотрудника — count(distinct) обязателен |
| t-legal-position-change | table | legal, movement | Трансферы по юридической структуре | kb/tables/legal-position-attr-chng.md | urn:dd:tables:greenplum:table:sse_crossdata.legal_position_attr_chng | legal_position_attr_chng, трансферы сотрудников, перемещение сотрудников по юридической структуре, трансферы по юридической структуре, изменение юридической позиции, переводы по юрструктуре | active | Лог ИЗМЕНЕНИЙ, не срез. Джойн по НЕРАВЕНСТВУ business_dt <= change_dt — задваивает строки, нужен ROW_NUMBER |
| t-management-unit | table | headcount-structure | Справочник юнитов управленческой структуры | kb/tables/management-unit.md | urn:dd:tables:dlh:table:dds.management_unit | management_unit, dds.management_unit, справочник юнитов, юниты управленческой структуры, management_unit_id, management_unit_rk, ключ юнита управленческой структуры | active | Переводит id юнита из ссылки в management_unit_rk — в основных витринах есть только rk. Версионная: valid_to_dttm='5999-01-01' |
| t-meeting-room | table | meetings | Переговорки Outlook | kb/tables/meeting-room.md | urn:dd:tables:greenplum:table:sse_crossdata.meeting_room | meeting_room, переговорки, переговорка, адрес переговорки, почта переговорки, название переговорки | active | Адреса почт переговорок Outlook: название, primary/secondary email |
| t-performance-metric | table | attendance | Подневные метрики активности сотрудников | kb/tables/performance-metric-d.md | urn:dd:tables:greenplum:table:sse_crossdata.performance_metric_d | performance_metric_d, часы работы сотрудников, подневные метрики, продолжительность работы, активная работа, сколько часов работал, дневная активность, перформанс сотрудников | active | Часы активной работы: duration_hour. Собрана из восьми источников — пустой день значит «активности не увидели», а не «не работал» |
| t-statement-field | table | personal-attributes | Поля заявлений сотрудников | kb/tables/statement-field.md | urn:dd:tables:greenplum:table:sdp_edms_statement.statement_field | statement_field, заявления сотрудников, поля заявлений, описание заявления, развернутое описание заявления, что написано в заявлении, содержимое заявления | active | Что написано в заявлении: field_nm + field_txt. Даты — текстом, дубли полей внутри заявления, джойн по statement_id (не по id) |
| t-summary-evaluation | table | personal-attributes | Итоговые годовые оценки сотрудников | kb/tables/summary-evaluation.md | urn:dd:tables:greenplum:table:hrmart.summary_evaluation | summary_evaluation, ревью, годовые оценки, оценки сотрудников | active | Годовые оценки сотрудников. Обязателен фильтр valid_to_dttm='5999-01-01' и deleted_flg=0 |
| t-vacation-plan | table | attendance | Запланированные отпуска сотрудников | kb/tables/vacation-plan.md | urn:dd:tables:greenplum:table:hrmart.statement_vacation | statement_vacation, запланированные отпуска, будущие отпуска сотрудников, график отпусков, план отпусков | active | Плановые отпуска: ежегодный основной, дополнительный и др., с датами начала/окончания. Обязателен фильтр etl_deleted_flg = 0 |

## Самостоятельные выгрузки

Отчёты-трансформеры: коллега настраивает нужные атрибуты и фильтры сам,
без обращения в поддержку. Строка здесь не заменяет строку в «Сущности» —
это дополнительная разметка поверх уже зарегистрированного отчёта, только
для режима выгрузки (`is_export`).

Ключевые слова матчатся кодом по тексту обращения, а не промптом:
совпадение — сигнал «предложить отчёт», а не гарантия, что там есть все
нужные атрибуты.

Матчинг идёт по тому, что написал **человек**: подписи полей формы и всё
в круглых скобках из текста выбрасываются. Это важно при правке списка —
слова из служебного текста формы сюда писать бессмысленно, они не совпадут
никогда. И наоборот: слово, которое стоит в подписи поля или в варианте
выпадающего списка, совпадёт не с запросом, а со шаблоном, то есть отчёт
будет предлагаться всем подряд. Так «ФИО» из варианта «Персональные данные
сотрудников (неполное ФИО, логин, раб. почта…)» однажды оказалось
единственным совпадением на обращении, которое было совсем про другое. Список полей и фильтров отчёта бот не проверяет — это
и так видно самому коллеге при открытии отчёта, автор лишь предлагает
попробовать и явно оговаривает, что не найдётся — оформляем выгрузку
обычным путём.

`id отчёта` обязан существовать в таблице «Сущности» с типом `report`.

| id отчёта | ключевые слова |
|---|---|
| r-hr-detail-list | детальные списки, атрибуты сотрудника, контакты сотрудников, MasterID, ФИО, табельный номер, грейд, стаж, руководитель, HRBP, управленческая структура, юридическая структура, логин, ad_login, юнит, состав команды, список сотрудников, my.tbank.ru/structure |

## Маршруты

**Кого позвать, когда дежурный сам не отвечает.** Есть доменные области,
в которых экспертизы дежурного не хватает, и по флоу зовётся тот, у кого она
есть. В фидбеке аналитика за 14–26 августа так решались 13 обращений из 49:
ответа в базе на них нет и быть не может, а бот отвечал по витринам, потому
что домен формально определялся.

**Это не переадресация и не «обращение не к нам».** Часть людей в таблице —
сотрудники CrossData, обращение остаётся нашим, просто в этой теме разбирается
не дежурный. Часть адресатов действительно в других командах, но отдельного
признака для них нет: действие одно и то же, а формулировка «это ведёт
не наша команда» была бы неверной для половины строк и читалась бы как отказ
в помощи там, где мы помогаем.

Ключевые слова матчатся **кодом** по тексту обращения — так же, как
«Самостоятельные выгрузки», и с той же чисткой: шапка формы, подписи полей
и всё в круглых скобках выбрасываются. Значит, слова из служебного текста
формы писать сюда бессмысленно — они не совпадут никогда, а слово из подписи
поля совпадёт в каждом втором обращении и маршрут начнут игнорировать.

**Маршрут — утверждение про человека, и оно протухает молча.** Владельца
отчёта мы для этого и не дублируем в git, а берём онлайн из Data Detective
(`kb/process/metadata-sources.md`). Здесь так не выйдет: объекта «кто ведёт
квоты» в каталоге нет, взять онлайн неоткуда. Поэтому маршрут живёт в git
**с датой**, и дата уходит джуну вместе с именем. Просроченный маршрут так
виден, а не работает до первого «этот человек уволился полгода назад».
Подтвердили маршрут в живом обращении — обновите дату тем же коммитом.

Колонки: `кому` — кого звать в тред обращения, `где` — канал или бот, куда
задаётся сам вопрос; прочерк в любой из них значит «здесь ничего», а не
пустое имя. `проверено` — когда маршрут последний раз подтверждался практикой.

Эксперт **не заменяет ответ**. Если на вопрос есть ответ в базе — сначала
ответ, и только потом «позовём такого-то». Обратный порядок превращает
поддержку в справочную «идите к такому-то» и обесценивает её там, где она
полезна.

Список слов выверен по выгрузке канала за июль–август: маршрут срабатывает
на 3 % строк (7 из 204), и каждое срабатывание — по адресу. Это и есть нужный
порядок: маршрут — редкий и точный сигнал, а не строка, которая появляется
в каждом втором ответе. **Проверять новое слово по выгрузке обязательно** —
совпадение здесь идёт подстрокой, и на глаз это не видно. Так были выброшены
слова, которые кажутся очевидными:

| слово | почему выброшено |
|---|---|
| `найм` | «данные о найме/оттоке» — это домен `movement` и наш ответ, а не подбор |
| `кандидат` | совпало на отчёте «проверка кандидатов» и на реферальной программе — оба наши |
| `оклад` | внутри слова «доклад», плюс совпало на нашей же выгрузке «данные для установления окладов» |
| `преми` | совпало на C&B-отчёте, где верным адресатом был другой человек: неверное имя хуже отсутствующего |
| `рид` | внутри «гибрид» и «юридический» — четыре ложных совпадения из четырёх |
| `фот` | внутри «фото»; три настоящих совпадения были нашими выгрузками |
| `юрлиц` | «с разбивкой по юрлицам» — наш вопрос про данные, а не просьба дать список юрлиц |

Двух строк здесь нет намеренно:

- **Согласование ИБ при передаче за пределы группы компаний.** Признак
  проставляет человек в поле intake-формы, и правило разбирается по нему
  детерминированно, а не по совпадению слова в тексте. Завести строку и здесь
  значило бы держать одно требование в двух местах — они разъедутся молча,
  и разъедется именно то, у которого цена ошибки максимальная.
- **Встречи и календарь.** В фидбеке маршрут есть («коллега по домену»),
  а имени нет. Строка без адресата ничего не решает: джун всё равно идёт
  спрашивать, кто это. Заводится, когда имя появится.

| маршрут | ключевые слова | кому | где | проверено |
|---|---|---|---|---|
| datamart-change | доработка витрины, доработать витрину, добавить поле в витрину, новое поле в витрине, новый атрибут в витрине | HC Data | — | 2026-08-26 |
| forge | forge, фордж | Оксана К. | — | 2026-08-26 |
| legal-entities | список юрлиц, перечень юрлиц, реестр юрлиц, ликвидац | Kristina Mamaryan | — | 2026-08-26 |
| payroll | зарплат, начислени, доплат, вознаграждени, фонд оплаты труда | Artur Mermovich | — | 2026-08-26 |
| quotas | квот | Kirill Seliverstov | — | 2026-08-26 |
| recruitment | рекрутмент, рекрутер, воронка найма, источники найма, время закрытия вакансии, оффер | — | ~recruitment_reports_ask | 2026-08-26 |
| usr-cnb-access | usr_cnb | Vladimir Novitskiy, Vadim Akulenko, @hcdataduty | бот /dataplatform | 2026-08-26 |
