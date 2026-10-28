# Cursor & Hermes AI services для BB

Отдельное дополнение для заголовков тредов и сообщений коммитов. Встроенный
`provider-acp` и файлы приложения BB остаются штатными. Голосовой ввод не реализован.

## Установка

Требуются BB >=0.48 и SDK 0.6.94; совместимость SDK ограничена веткой 0.6.
На выбранной машине должны быть установлены и авторизованы `cursor-agent` или
`hermes` с поддержкой ACP. Дополнение не устанавливает и не обновляет эти CLI.

```sh
npm ci --include=dev
npm test
npm run check:sdk
npm run build
bb plugin install .
```

## Настройка

Настройки доступны в Settings → Installed plugins → Cursor & Hermes AI services.
`cursorMachine` и `hermesMachine` — ID из `bb machine list`; пустое значение означает
основную машину BB. `cursorCommand` и `hermesCommand` — имя команды из PATH или
абсолютный путь. Для Windows запускается штатный SDK-процесс без окна терминала.
`cursorModel` и `hermesModel` — точные идентификаторы моделей ACP; пустое значение
сохраняет модель CLI. Для Cursor идентификатор ACP может отличаться от CLI-алиаса.
`cursorProxy` задаёт HTTPS_PROXY только для процесса Cursor; URL с паролем хранить
в этом поле нельзя. Авторизация используется из существующей установки CLI.

Пример настройки машин:

```sh
bb machine list --json
bb plugin config cursor-hermes-ai set cursorMachine host_example
bb plugin config cursor-hermes-ai set hermesMachine host_another
bb plugin config cursor-hermes-ai set cursorProxy http://proxy.infostart.loc:3128
bb cursor-hermes-ai test --service cursor --task thread-title
bb cursor-hermes-ai test --service cursor --task commit-message
bb cursor-hermes-ai test --service hermes --task thread-title
bb cursor-hermes-ai test --service hermes --task commit-message
bb cursor-hermes-ai status --json
```

После успешной проверки сервис доступен в Settings → AI services для заголовков
и сообщений коммитов. При желании его можно выбрать явно:

```sh
bb settings ai-services set thread-title cursor --plugin cursor-hermes-ai
bb settings ai-services set commit-message hermes --plugin cursor-hermes-ai
```

Выбор задач сохраняет BB. Дополнение само этот выбор не изменяет. В режиме
Automatic BB учитывает новые готовые сервисы в своём штатном порядке.

## Выполнение и ограничения

В отдельном host worker работает один подготовленный процесс ACP на сервис.
Он остаётся в памяти до отключения/перезагрузки дополнения. Каждый запрос получает
новую сессию без истории предыдущего. Для ограничения памяти процесс пересоздаётся
после 32 запросов. Во время подготовки сервис временно неготов; после запуска BB
первое обращение к статусу запускает подготовку. Одновременно выполняется один
запрос на сервис; второй получает явную ошибку занятости.

Текст генерируется в пустом временном каталоге; собственные MCP-серверы не
передаются. Cursor используется в режиме Ask, Hermes — в Default с запросом
разрешений. Дополнение отклоняет разрешения инструментов и не предоставляет
операции чтения/записи файлов или терминал. Плагины BB и сами агенты остаются
доверенными программами; отдельной песочницы этот механизм не создаёт.

Штатный тайм-аут BB — 5 секунд, внутри host вызова генерация ограничена 4,6 секунды.
Подготовка ACP выполняется заранее и в этот бюджет не входит. При отмене или
тайм-ауте процесс останавливается. Для его повторной подготовки запустите `test`.
При изменении машины, команды, модели или прокси требуется новая проверка. Её
результат сохраняется между перезапусками BB. Проверка использует короткий реальный
запрос к модели и расходует лимит аккаунта. Не запускайте `test` во время генерации:
эта команда пересоздаёт служебный процесс.

Ошибки авторизации устраняются штатным входом на выбранной машине: `cursor-agent
login` или `hermes login`. После входа повторите проверку. Дополнение не переключает
аккаунты, модели или провайдеров при ошибке.

## Проверка после обновления BB

```sh
npm run check:sdk
npm test
npm run build
bb plugin reload cursor-hermes-ai
bb cursor-hermes-ai test --service cursor --task thread-title
bb cursor-hermes-ai test --service cursor --task commit-message
bb cursor-hermes-ai test --service hermes --task thread-title
bb cursor-hermes-ai test --service hermes --task commit-message
bb settings ai-services --json
```

Если изменился SDK, изучите его публичный контракт, затем выполните `bb plugin
types .`, `npm install`, внесите необходимые изменения и повторите проверки.
Расширяйте engines.bbPluginSdk после проверки новой ветки SDK.

Логи проверки: `bb plugin logs cursor-hermes-ai -n 20`. В них сохраняются только
сервис, тип проверки, длительность и сообщение ошибки; обычные запросы и ответы
пользователя не записываются. Исходники и package-lock.json храните отдельными
коммитами этого репозитория. Локальная установка по пути сохраняется при обновлении
BB; совместимость экспериментального SDK иногда потребует адаптации дополнения.
