from app.routes.main import main_bp
from app.routes.glossary import glossary_bp
from app.routes.meetings import meetings_bp


def register_blueprints(app):
    app.register_blueprint(main_bp)
    app.register_blueprint(glossary_bp)
    app.register_blueprint(meetings_bp)
