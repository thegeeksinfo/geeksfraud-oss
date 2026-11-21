"""
Reference check: train XGBoost on exactly the data and settings our TypeScript GBDT
used (bench/run.ts --export), and compare test metrics. If our implementation is
correct, the numbers should be within noise of XGBoost's.

    python3 bench/xgb_reference.py
"""
import os
import numpy as np
import xgboost as xgb
from sklearn.metrics import roc_auc_score, average_precision_score

here = os.path.join(os.path.dirname(__file__), "data")


def load(name):
    d = np.loadtxt(os.path.join(here, f"{name}.csv"), delimiter=",", skiprows=1)
    return d[:, :-1], d[:, -1]


def recall_at_fpr(scores, labels, fpr=0.01):
    neg = np.sort(scores[labels == 0])[::-1]
    k = int(fpr * len(neg))
    thr = neg[k] if k < len(neg) else -np.inf
    return float((scores[labels == 1] > thr).mean())


Xtr, ytr = load("train")
Xva, yva = load("valid")
Xte, yte = load("test")

model = xgb.XGBClassifier(
    n_estimators=400,
    learning_rate=0.06,
    max_depth=5,
    min_child_weight=3,
    reg_lambda=1.0,
    subsample=0.8,
    colsample_bytree=0.8,
    tree_method="hist",
    max_bin=64,
    early_stopping_rounds=40,
    eval_metric="logloss",
    random_state=7,
    n_jobs=2,
)
model.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
p = model.predict_proba(Xte)[:, 1]
ours = np.loadtxt(os.path.join(here, "ours_test_scores.csv"))

rows = [
    ("XGBoost 3.x (reference)", p, model.best_iteration + 1),
    ("GeeksFraud GBDT (TypeScript)", ours, None),
]
print("| Implementation | trees | ROC-AUC | PR-AUC | Caught @1% FPR |")
print("|---|---|---|---|---|")
for name, s, n in rows:
    print(f"| {name} | {n or '-'} | {roc_auc_score(yte, s):.4f} | {average_precision_score(yte, s):.4f} | {recall_at_fpr(s, yte):.1%} |")
print(f"\nRank correlation between the two models' test scores: {np.corrcoef(np.argsort(np.argsort(p)), np.argsort(np.argsort(ours)))[0, 1]:.3f}")
