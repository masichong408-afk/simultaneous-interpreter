from app.extensions import db
from datetime import datetime, timezone


class TermCategory(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    parent_id = db.Column(db.Integer, db.ForeignKey('term_category.id'), nullable=True)
    display_order = db.Column(db.Integer, nullable=False, default=0)

    parent = db.relationship('TermCategory', remote_side=[id], backref='children', lazy=True)
    terms = db.relationship('Term', backref='category', lazy='dynamic', cascade="all, delete-orphan")

    def __repr__(self):
        return f'<TermCategory {self.name}>'


class Term(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    source = db.Column(db.String(500), nullable=False, index=True)
    target = db.Column(db.String(500), nullable=False)
    notes = db.Column(db.Text, nullable=True)
    category_id = db.Column(db.Integer, db.ForeignKey('term_category.id'), nullable=False)

    def __repr__(self):
        return f'<Term {self.source}>'


class Meeting(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200))
    start_time = db.Column(db.DateTime, nullable=False)
    end_time = db.Column(db.DateTime)
    duration_seconds = db.Column(db.Integer, default=0)
    transcript_path = db.Column(db.String(500))
    status = db.Column(db.String(20), default='recording')
    speak_direction = db.Column(db.String(10))
    listen_direction = db.Column(db.String(10))
