# MCP сервер для работы с БД

Безопасный MCP (Model Context Protocol) сервер для работы с базами данных Skyeng Platform без передачи кредов в удаленное API.

## 🎯 Возможности

- **Безопасность**: для обычных БД только SELECT, WITH, EXPLAIN; для тестовых БД вида `*_auto_y10` или `*_auto_s2` разрешены любые запросы
- **Простота**: прямая работа с БД по названию
- **Кэширование**: схемы таблиц кэшируются для быстрого доступа
- **Мониторинг**: логирование всех запросов и производительности


## 🚀 Установка

```bash
# Клонируем проект
git clone https://github.com/CynepHy6/mcp-db.git mcp-db
cd mcp-db

# Создаем виртуальное окружение и устанавливаем зависимости
python3 -m venv venv
source venv/bin/activate
pip install -r requirements-mcp.txt
```

## ⚙️ Настройка

### 1. Настройка кредов БД

```bash
# Копируем пример конфигурации
cp .db.yaml.example .db.yaml

# Редактируем файл с кредами
nano .db.yaml
```

Пример содержимого `.db.yaml` в старом формате:
```yaml
db_name:
  db_host_name.link: port
  user_name: user_password
```

Рекомендуемый формат для тестинговых БД:
```yaml
_templates:
  test_y10_pg11:
    host: test-y10-local.skyeng.link
    port: 5432
    user: ya_testing
    password: your_password
  test_y10_pg15:
    host: test-y10-local.skyeng.link
    port: 5532
    user: ya_testing
    password: your_password

skysmart_english_auto_y10:
  template: test_y10_pg11

trm_auto_y10:
  template: test_y10_pg11

teacher_catalog_auto_y10:
  template: test_y10_pg15

crm_auto_y10:
  template: test_y10_pg15
```

При необходимости можно переопределить отдельные поля поверх шаблона:
```yaml
teacher_catalog_auto_y10:
  template: test_y10_pg11
  port: 5532
```

Если имя БД на сервере не совпадает с ключом в конфиге, задайте поле `database`:
```yaml
service_auto_env:
  template: test_mysql
  database: actual_db_name
```

Оба формата поддерживаются: старый плоский формат остается рабочим для обратной совместимости.

Тип СУБД определяется автоматически:
- для реплик — по префиксу хоста: `mysql-*` → MySQL, `pgsql-*` → PostgreSQL;
- для тестингов (хост без префикса) — по порту:
  - `3306` → MySQL (mysql8);
  - `5432` → PostgreSQL (pg11);
  - `5532` → PostgreSQL (pg15);
- явное поле `type` в конфиге переопределяет автоопределение.

### 2. Настройка таймаута подключения (опционально)

По умолчанию таймаут подключения к БД составляет 2 секунды. При необходимости можно изменить через переменную окружения:

```bash
# Быстрая проверка (может пропустить БД при небольших задержках)
export MCP_DB_CONNECT_TIMEOUT=1

# Более надежное подключение (для нестабильной сети)
export MCP_DB_CONNECT_TIMEOUT=3
```

Инструмент `list_databases` опрашивает все БД параллельно (до 16 одновременных подключений по умолчанию). Число потоков можно задать так:

```bash
export MCP_DB_LIST_MAX_WORKERS=8
```

### 3. Тестирование

```bash
# Активируем виртуальное окружение
source venv/bin/activate

# Тестируем подключение к БД
python3 mcp-db-server.py
```

### 4. Интеграция с Cursor

По умолчанию сервер читает `.db.yaml` из каталога `mcp-db`. Чтобы указать другой файл, задайте `MCP_DB_CONFIG` — абсолютный путь к YAML с кредами.

Добавьте в `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "DB": {
      "command": "/absolute/path/to/mcp-db/mcp-server",
      "env": {
        "MCP_DB_CONFIG": "/absolute/path/to/.db.yaml",
      }
    }
  }
}
```

Если `MCP_DB_CONFIG` не задан, используется `/absolute/path/to/mcp-db/.db.yaml` рядом с сервером — тогда блок `env` можно убрать целиком:

```json
{
  "mcpServers": {
    "DB": {
      "command": "/absolute/path/to/mcp-db/mcp-server"
    }
  }
}
```

## 🔒 Безопасность

- Только чтение для обычных БД: разрешены только немодифицирующие запросы
- Тестовые БД вида `*_auto_<env>`: разрешены любые запросы, если имя БД заканчивается на шаблон `_auto_\w\d+`
- Локальные креды: пароли хранятся только локально в `.db.yaml`
- Валидация запросов: фильтрация опасных операций и поддержка шаблонов `_templates` в конфиге
- Логирование: все запросы записываются в `mcp-db-server.log`

## 📁 Структура проекта

```
mcp-db/
├── mcp-db-server.py          # Основной сервер
├── mcp-server               # Исполняемый скрипт-обертка
├── venv/                    # Виртуальное окружение
├── requirements-mcp.txt      # Зависимости Python
├── .db.yaml                 # Креды БД (создается вручную)
├── .db.yaml.example         # Пример конфигурации
└── README.md               # Документация
```

## 🔍 Пример использования

После настройки MCP в Cursor можете задавать вопросы:
- "Покажи информацию о БД math"
- "Какие таблицы есть в БД skysmart_english?"
- "Покажи схему таблицы users в БД math"


## 🔧 Диагностика

При возникновении проблем:

1. Проверьте логи в `mcp-db-server.log`
2. Убедитесь что `.db.yaml` содержит правильные креды
3. Тестируйте подключение: `./mcp-server --test`
