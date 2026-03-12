import csv
import io
from flask import Blueprint, request, jsonify, Response
from app.extensions import db
from app.models import Term, TermCategory

glossary_bp = Blueprint('glossary', __name__, url_prefix='/api/glossary')


@glossary_bp.route('/categories', methods=['GET'])
def get_categories():
    categories = TermCategory.query.order_by(TermCategory.display_order).all()

    category_map = {}
    for c in categories:
        category_map[c.id] = {
            'id': c.id,
            'name': c.name,
            'parent_id': c.parent_id,
            'is_public': False,
            'children': []
        }

    tree = []
    for c in categories:
        node = category_map[c.id]
        if c.parent_id is None:
            tree.append(node)
        elif c.parent_id in category_map:
            category_map[c.parent_id]['children'].append(node)

    return jsonify(tree)


@glossary_bp.route('/categories', methods=['POST'])
def create_category():
    data = request.get_json()
    if not data or not data.get('name'):
        return jsonify({'error': '分类名称不能为空'}), 400

    max_order = db.session.query(db.func.max(TermCategory.display_order)).filter_by(
        parent_id=data.get('parent_id')
    ).scalar() or 0
    new_category = TermCategory(
        name=data.get('name'),
        parent_id=data.get('parent_id'),
        display_order=max_order + 1
    )

    db.session.add(new_category)
    db.session.commit()
    return jsonify({'id': new_category.id, 'name': new_category.name, 'parent_id': new_category.parent_id}), 201


@glossary_bp.route('/categories/<int:category_id>', methods=['PUT'])
def update_category(category_id):
    category = TermCategory.query.get_or_404(category_id)

    data = request.get_json()
    if not data or not data.get('name'):
        return jsonify({'error': '新名称不能为空'}), 400
    category.name = data['name']
    db.session.commit()
    return jsonify({'message': '分类已更新'})


@glossary_bp.route('/categories/<int:category_id>', methods=['DELETE'])
def delete_category(category_id):
    category_to_delete = TermCategory.query.get_or_404(category_id)

    uncategorized = TermCategory.query.filter_by(name="未分类", parent_id=None).first()
    if not uncategorized:
        uncategorized = TermCategory(name="未分类", display_order=0)
        db.session.add(uncategorized)
        db.session.flush()

    Term.query.filter_by(category_id=category_id).update({'category_id': uncategorized.id})
    TermCategory.query.filter_by(parent_id=category_id).update({'parent_id': None})

    db.session.delete(category_to_delete)
    db.session.commit()
    return jsonify({'message': '分类已删除，术语已移至"未分类"'})


@glossary_bp.route('/categories/reorder', methods=['POST'])
def reorder_categories():
    data = request.get_json()
    ordered_ids = data.get('ordered_ids')
    if not isinstance(ordered_ids, list):
        return jsonify({'error': '数据格式无效'}), 400
    for index, category_id in enumerate(ordered_ids):
        category = TermCategory.query.get(category_id)
        if category:
            category.display_order = index
    db.session.commit()
    return jsonify({'message': '分类排序已更新'})


@glossary_bp.route('/terms', methods=['GET'])
def get_terms():
    category_id = request.args.get('category_id', type=int)
    if not category_id:
        return jsonify({'error': '缺少 category_id 参数'}), 400

    category = TermCategory.query.get_or_404(category_id)
    terms = Term.query.filter_by(category_id=category.id).order_by(Term.source).all()
    term_list = [{'id': t.id, 'source': t.source, 'target': t.target, 'notes': t.notes} for t in terms]
    return jsonify(term_list)


@glossary_bp.route('/terms', methods=['POST'])
def create_term():
    data = request.get_json()
    if not data:
        return jsonify({'error': '请求数据为空'}), 400
    if not data.get('category_id') or not data.get('source') or not data.get('target'):
        return jsonify({'error': '缺少必填字段（category_id, source, target）'}), 400
    TermCategory.query.get_or_404(data['category_id'])
    new_term = Term(
        source=data['source'],
        target=data['target'],
        notes=data.get('notes'),
        category_id=data['category_id']
    )
    db.session.add(new_term)
    db.session.commit()
    return jsonify({'id': new_term.id, 'source': new_term.source, 'target': new_term.target, 'notes': new_term.notes}), 201


@glossary_bp.route('/terms/<int:term_id>', methods=['PUT'])
def update_term(term_id):
    term = Term.query.get_or_404(term_id)
    data = request.get_json()
    term.source = data.get('source', term.source)
    term.target = data.get('target', term.target)
    term.notes = data.get('notes', term.notes)
    if 'category_id' in data:
        TermCategory.query.get_or_404(data['category_id'])
        term.category_id = data['category_id']
    db.session.commit()
    return jsonify({'message': '术语已更新'})


@glossary_bp.route('/terms/<int:term_id>', methods=['DELETE'])
def delete_term(term_id):
    term = Term.query.get_or_404(term_id)
    db.session.delete(term)
    db.session.commit()
    return jsonify({'message': '术语已删除'}), 200


@glossary_bp.route('/terms/move', methods=['POST'])
def move_terms():
    data = request.get_json()
    term_ids = data.get('term_ids')
    target_category_id = data.get('target_category_id')
    if not term_ids or not target_category_id:
        return jsonify({'error': '缺少 term_ids 或 target_category_id'}), 400
    TermCategory.query.get_or_404(target_category_id)
    Term.query.filter(Term.id.in_(term_ids)).update(
        {'category_id': target_category_id}, synchronize_session=False
    )
    db.session.commit()
    return jsonify({'message': f'已移动 {len(term_ids)} 个术语'})


@glossary_bp.route('/terms/delete_bulk', methods=['POST'])
def delete_bulk_terms():
    data = request.get_json()
    term_ids = data.get('term_ids')
    if not term_ids or not isinstance(term_ids, list):
        return jsonify({'error': '数据格式无效'}), 400
    num_deleted = Term.query.filter(Term.id.in_(term_ids)).delete(synchronize_session=False)
    db.session.commit()
    return jsonify({'message': f'已删除 {num_deleted} 个术语'})


@glossary_bp.route('/terms/unify', methods=['POST'])
def unify_term():
    data = request.get_json()
    source_text, new_target_text = data.get('source'), data.get('target')
    terms_to_update = Term.query.filter_by(source=source_text).all()
    if not terms_to_update:
        return jsonify({'message': '没有需要统一的术语'}), 200
    update_count = 0
    for term in terms_to_update:
        if term.target != new_target_text:
            term.target = new_target_text
            update_count += 1
    if update_count > 0:
        db.session.commit()
    return jsonify({'message': f'已统一 {len(terms_to_update)} 个术语'})


@glossary_bp.route('/conflicts', methods=['GET'])
def find_conflicts():
    from sqlalchemy import func, distinct
    conflicting_sources = db.session.query(Term.source).group_by(
        Term.source
    ).having(func.count(distinct(Term.target)) > 1).all()
    source_texts = [s[0] for s in conflicting_sources]
    conflict_groups = []
    if source_texts:
        conflicts = Term.query.filter(Term.source.in_(source_texts)).order_by(Term.source).all()
        temp_map = {}
        for term in conflicts:
            if term.source not in temp_map:
                temp_map[term.source] = set()
            temp_map[term.source].add(term.target)
        for source, targets in temp_map.items():
            conflict_groups.append({'source': source, 'targets': sorted(list(targets))})
    return jsonify(conflict_groups)


@glossary_bp.route('/export', methods=['GET'])
def export_terms():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['source', 'target', 'notes', 'category_name'])
    terms = db.session.query(Term, TermCategory.name).join(TermCategory).all()
    for term, category_name in terms:
        writer.writerow([term.source, term.target, term.notes or '', category_name])
    output.seek(0)
    return Response(
        output.getvalue().encode('utf-8-sig'),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment;filename=glossary_export.csv"}
    )


@glossary_bp.route('/import', methods=['POST'])
def import_terms():
    if 'file' not in request.files:
        return jsonify({'error': '未上传文件'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '未选择文件'}), 400

    category_id = request.form.get('category_id', type=int)
    if not category_id:
        return jsonify({'error': '缺少 category_id 参数'}), 400
    TermCategory.query.get_or_404(category_id)

    if file and file.filename.endswith('.csv'):
        try:
            raw_data = file.stream.read()
            text_data = ""
            try:
                text_data = raw_data.decode("utf-8-sig")
            except UnicodeDecodeError:
                try:
                    text_data = raw_data.decode("gb18030")
                except UnicodeDecodeError:
                    return jsonify({'error': '文件编码不支持，请将文件另存为 UTF-8 或 GBK 格式'}), 400

            stream = io.StringIO(text_data, newline=None)
            csv_reader = csv.reader(stream)

            imported_count = 0
            for row in csv_reader:
                if len(row) < 2:
                    continue
                source_text = row[0].strip()
                target_text = row[1].strip()
                notes_text = row[2].strip() if len(row) > 2 and row[2] else None

                if not source_text or not target_text:
                    continue

                if ("原文" in source_text or "source" in source_text.lower()) and \
                   ("译文" in target_text or "target" in target_text.lower()):
                    continue

                new_term = Term(
                    source=source_text,
                    target=target_text,
                    notes=notes_text,
                    category_id=category_id
                )
                db.session.add(new_term)
                imported_count += 1

            db.session.commit()
            return jsonify({'message': f'成功导入 {imported_count} 条术语。'})

        except Exception as e:
            db.session.rollback()
            return jsonify({'error': f'导入发生错误: {str(e)}'}), 500

    return jsonify({'error': '文件格式无效，请上传 CSV 文件'}), 400
