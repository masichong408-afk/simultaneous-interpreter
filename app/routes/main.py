from flask import Blueprint, render_template
from app.models import TermCategory

main_bp = Blueprint('main', __name__)


@main_bp.route('/')
def index():
    categories = TermCategory.query.order_by(TermCategory.display_order).all()
    return render_template('index.html', categories=categories)


@main_bp.route('/glossary')
def glossary_management():
    return render_template('glossary.html')
