import os
from dotenv import load_dotenv

basedir = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))

load_dotenv(os.path.join(basedir, '.env'))


class Config:
    SECRET_KEY = os.environ.get('FLASK_SECRET_KEY') or 'default-key-for-dev-only'

    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') or \
        'sqlite:///' + os.path.join(basedir, 'app.db')
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    UPLOAD_FOLDER = os.path.join(basedir, 'uploads')
    MAX_CONTENT_LENGTH = 100 * 1024 * 1024  # 100MB

    VOLCANO_APP_KEY = os.environ.get("VOLCANO_APP_KEY")
    VOLCANO_ACCESS_KEY = os.environ.get("VOLCANO_ACCESS_KEY")
