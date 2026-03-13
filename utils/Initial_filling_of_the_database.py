import sqlite3
import re

# Пути к файлам. 
# Используем r перед строкой (raw-string), чтобы обратные слеши корректно обрабатывались в Windows.
db_path = r"C:\Users\user\Documents\BookGuesser2\data\bg.db"
file_path = r"C:\Users\user\Documents\BookGuesser2\data\books.txt"

def main():
    conn = None
    try:
        # 1. Подключаемся к базе данных
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Включаем поддержку внешних ключей (важно для целостности данных)
        cursor.execute("PRAGMA foreign_keys = ON;")
        
        # 2. Читаем текстовый файл
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # 3. Парсим данные с помощью регулярных выражений
        # Шаблон ищет title: "..." и author: "..."
        # [\s\S]*? означает "любые символы включая переносы строк"
        pattern = r'title:\s*"([^"]+)"[\s\S]*?author:\s*"([^"]+)"'
        matches = re.findall(pattern, content)
        
        # Словарь для кэширования ID авторов, чтобы не делать лишних запросов к БД
        authors_cache = {}
        
        for title, author_name in matches:
            # Удаляем лишние пробелы
            title = title.strip()
            author_name = author_name.strip()
            
            author_id = None
            
            # Проверяем, есть ли автор в нашем кэше
            if author_name in authors_cache:
                author_id = authors_cache[author_name]
            else:
                # Ищем автора в базе данных
                cursor.execute("SELECT id FROM authors WHERE name = ?", (author_name,))
                result = cursor.fetchone()
                
                if result:
                    # Автор найден, берем его ID
                    author_id = result[0]
                else:
                    # Автора нет, создаем новую запись
                    cursor.execute("INSERT INTO authors (name) VALUES (?)", (author_name,))
                    author_id = cursor.lastrowid
                
                # Сохраняем ID в кэш
                authors_cache[author_name] = author_id
            
            # Добавляем книгу в таблицу books
            # Поля origin_country, publication_year и file оставляем NULL (пустыми), так как их нет в файле
            cursor.execute(
                "INSERT INTO books (title, author_id) VALUES (?, ?)", 
                (title, author_id)
            )
            
        # Сохраняем изменения
        conn.commit()
        print(f"Успешно обработано записей: {len(matches)}")
        
    except sqlite3.Error as e:
        print(f"Ошибка при работе с базой данных: {e}")
    except FileNotFoundError:
        print("Ошибка: Файл не найден. Проверьте правильность путей.")
    except Exception as e:
        print(f"Произошла непредвиденная ошибка: {e}")
    finally:
        # Закрываем соединение
        if conn:
            conn.close()

if __name__ == "__main__":
    main()