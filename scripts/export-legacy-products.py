"""Read-only PostgreSQL/SQLite export; emits lossless product envelopes as JSONL.

Run on the machine owning the source. No target database or credentials are read.
Postgres: python3 export-legacy-products.py quant-pg product_staging DATASET [LIMIT]
SQLite: python3 export-legacy-products.py sqlite /path/no-company-products.sqlite DATASET [LIMIT]
"""
import json
import os
import sqlite3
import subprocess
import sys

container, database, dataset = sys.argv[1:4]
limit = int(sys.argv[4]) if len(sys.argv) > 4 else 0
if limit < 0:
    raise ValueError('Negative limit')
channels = ('amazon','swanson','gnc','dtc')

def emit(value):
    print(json.dumps(value,ensure_ascii=False,separators=(',',':')),flush=True)

if container == 'sqlite':
    if os.path.exists(database+'-wal'):
        raise RuntimeError('Use a consistent SQLite snapshot when WAL exists')
    before = os.stat(database)
    conn = sqlite3.connect('file:'+database+'?mode=ro&immutable=1',uri=True)
    conn.row_factory = sqlite3.Row
    sql = 'SELECT * FROM no_company_product ORDER BY channel,external_id' + (' LIMIT '+str(limit) if limit else '')
    for r in conn.execute(sql):
        row = dict(r)
        emit({'codec':'legacy-product/1','dataset':dataset,'kind':'no-company','product':row,
              'listings':[{'row':row,'snapshots':[]}],'images':[],'ingredients':[],'formulas':[],'formulaObservations':[]})
    conn.close()
    after = os.stat(database)
    assert (before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
    assert not os.path.exists(database+'-wal')
    sys.exit(0)

if database not in ('product_staging','product_restore','railway_local_new'):
    raise ValueError('Source database not in reviewed inventory')
docker = '/opt/homebrew/bin/docker' if os.path.exists('/opt/homebrew/bin/docker') else 'docker'
def q(sql):
    body = "\\set ON_ERROR_STOP on\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='120s';\n"+sql+'\nCOMMIT;\n'
    r = subprocess.run([docker,'exec','-i',container,'psql','-X','-q','-U','postgres','-d',database,'-At'],input=body,text=True,capture_output=True,check=True)
    # PostgreSQL json_agg can insert formatting newlines inside a single value.
    # Decode consecutive JSON values, not individual physical stdout lines.
    values, offset, decoder = [], 0, json.JSONDecoder()
    while offset < len(r.stdout):
        if r.stdout[offset].isspace():
            offset += 1
            continue
        value, offset = decoder.raw_decode(r.stdout, offset)
        values.append(value)
    return values
tables = q("SELECT coalesce(json_agg(table_name),'[]'::json) FROM information_schema.tables WHERE table_schema='public';")[0]
has_formula = 'formula' in tables and 'formula_observation' in tables
quoted_channels = "'amazon','swanson','gnc','dtc'"
selected = f"EXISTS(SELECT 1 FROM product_channel pc WHERE pc.product_id=p.id AND lower(pc.channel) IN ({quoted_channels}))" if database != 'railway_local_new' else f"EXISTS(SELECT 1 FROM unnest(p.sales_channels) c WHERE lower(c) IN ({quoted_channels}))"
ids = q(f"SELECT to_json(p.id) FROM product p WHERE p.source IS DISTINCT FROM 'faker' AND {selected} ORDER BY p.id"+(' LIMIT '+str(limit) if limit else '')+';')
for start in range(0,len(ids),50):
    batch = ids[start:start+50]
    id_sql = ','.join("'"+str(i).replace("'","''")+"'::uuid" for i in batch)
    images = "coalesce((SELECT json_agg(i ORDER BY i.id) FROM product_image i WHERE i.product_id=p.id),'[]'::json)" if 'product_image' in tables else "'[]'::json"
    ingredients = "coalesce((SELECT json_agg(json_build_object('link',to_jsonb(pi),'ingredient',to_jsonb(i)) ORDER BY pi.ingredient_id) FROM product_ingredient pi LEFT JOIN ingredient i ON i.id=pi.ingredient_id WHERE pi.product_id=p.id),'[]'::json)"
    if database == 'railway_local_new':
        listings = f"coalesce((SELECT json_agg(json_build_object('row',json_build_object('id',p.id::text||':'||c,'channel',lower(c),'original_product_url',coalesce(p.original_product_url,p.website)),'snapshots','[]'::json) ORDER BY c) FROM unnest(p.sales_channels) c WHERE lower(c) IN ({quoted_channels})),'[]'::json)"
    else:
        snapshots = "coalesce((SELECT json_agg(s ORDER BY s.captured_at,s.id) FROM listing_snapshot s WHERE s.listing_id=pc.id),'[]'::json)" if 'listing_snapshot' in tables else "'[]'::json"
        listings = f"coalesce((SELECT json_agg(json_build_object('row',to_jsonb(pc),'snapshots',{snapshots}) ORDER BY pc.id) FROM product_channel pc WHERE pc.product_id=p.id AND lower(pc.channel) IN ({quoted_channels})),'[]'::json)"
    formula_obs = "coalesce((SELECT json_agg(fo ORDER BY fo.observed_at,fo.id) FROM formula_observation fo WHERE fo.product_id=p.id),'[]'::json)" if has_formula else "'[]'::json"
    formulas = "coalesce((SELECT json_agg(json_build_object('row',to_jsonb(f),'rows',coalesce((SELECT json_agg(json_build_object('row',to_jsonb(fi),'ingredient',to_jsonb(i)) ORDER BY fi.position,fi.id) FROM formula_ingredient fi LEFT JOIN ingredient i ON i.id=fi.ingredient_id WHERE fi.formula_id=f.id),'[]'::json)) ORDER BY f.id) FROM formula f WHERE f.id=p.formula_id OR f.id IN(SELECT formula_id FROM formula_observation fo WHERE fo.product_id=p.id)),'[]'::json)" if has_formula else "'[]'::json"
    sql = f"""SELECT json_build_object('product',to_jsonb(p),'listings',{listings},'images',{images},
      'ingredients',{ingredients},'formulas',{formulas},'formulaObservations',{formula_obs})
      FROM product p WHERE p.id IN ({id_sql}) ORDER BY p.id;"""
    for row in q(sql):
        emit({'codec':'legacy-product/1','dataset':dataset,'kind':'reference' if database=='railway_local_new' else 'product',**row})
    print(json.dumps({'event':'LEGACY_EXPORT_PROGRESS','database':database,'records':min(start+50,len(ids)),'total':len(ids)}),file=sys.stderr,flush=True)
